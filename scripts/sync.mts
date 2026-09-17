#!/usr/bin/env node
/**
 * Feishu -> website content sync (TypeScript, runs natively on Node >= 23.6).
 * Design doc: docs/design/content-pipeline.md
 *
 * State machine (manual publish gate):
 *   draft     = not on the site (removes the article if it was published)
 *   pending   = publish order, the ONLY trigger, set manually by a human
 *   published = live; sync only probes the revision, flips to "updated" on change
 *   updated   = live but the Feishu doc changed, awaiting manual re-approval
 *
 * Identity split:
 *   all reads (tables, docs, media) -> bot (app identity, wiki member)
 *   table writes                    -> user (wiki admin; bot role is read-only)
 *
 * Usage:
 *   node scripts/sync.mts blog|publications|all [--no-push] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- Feishu constants ----
const BLOG_BASE = 'C4UHb2txzaU5IDsWrd2cGr7qnHe';
const BLOG_TABLE = 'tblFnCEsTkKjwRAl';
const PUBS_BASE = 'NRYTbayjcaD48asba8CcNyHined';
const PUBS_TABLE = 'tblwuIiPOZshexEC';
const READ_IDENTITY = 'bot';
const WRITE_IDENTITY = 'user';
const SITE_URL = 'https://openearthmodelling.github.io';

// ---- state machine ----
const S_DRAFT = 'draft';
const S_PENDING = 'pending';
const S_LIVE = 'published';
const S_STALE = 'updated';

// ---------------------------------------------------------------- types
interface LarkEnvelope<T> {
  ok: boolean;
  error?: { message?: string };
  data?: T;
}
interface RecordListData {
  fields: string[];
  record_id_list: string[];
  data: unknown[][];
}
interface DocumentData {
  document: { content?: string; revision_id?: number };
}
type RawRow = Record<string, unknown> & { _recordId: string };
interface BlogRow {
  recordId: string;
  title: string;
  status: string | null;
  doc: string;
  slug: string;
  summary: string;
  author: string;
  date: unknown;
  tags: string[];
  syncedRev: string;
}
interface Pub {
  title: string;
  authors: string;
  status: string;
  venue: string;
  year: number | null;
  volume: string;
  doi: string;
  url: string;
  tags: string[];
}

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('-')) ?? 'all';
const NO_PUSH = args.includes('--no-push');
const DRY = args.includes('--dry-run');

// ---------------------------------------------------------------- lark-cli
function lark<T>(cmdArgs: string[], identity: string): LarkEnvelope<T> {
  const out = execFileSync('lark-cli', [...cmdArgs, '--as', identity], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const i = out.indexOf('{');
  if (i < 0) throw new Error(`lark-cli produced no JSON: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(i)) as LarkEnvelope<T>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const firstSelect = (v: unknown): string | null =>
  Array.isArray(v) ? ((v[0] as string) ?? null) : ((v as string) ?? null);

function fetchRows(baseToken: string, tableId: string): RawRow[] {
  const res = lark<RecordListData>(
    ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--json'],
    READ_IDENTITY,
  );
  if (!res.ok || !res.data) throw new Error(`failed to read table: ${res.error?.message}`);
  const names = res.data.fields ?? [];
  const ids = res.data.record_id_list ?? [];
  return (res.data.data ?? []).map((row, i) => {
    const obj: RawRow = { _recordId: ids[i] ?? '' };
    names.forEach((n, j) => (obj[n] = row[j]));
    return obj;
  });
}

function updateRecords(
  baseToken: string,
  tableId: string,
  updates: Record<string, Record<string, unknown>>,
): void {
  const res = lark<unknown>(
    [
      'base', '+record-batch-update',
      '--base-token', baseToken, '--table-id', tableId,
      '--json', JSON.stringify({ update_records: updates }),
    ],
    WRITE_IDENTITY,
  );
  if (!res.ok) throw new Error(`failed to write back: ${res.error?.message}`);
}

/** Lightweight revision probe: fetches only the heading outline. */
function probeRevision(docUrl: string): number | null {
  try {
    const res = lark<DocumentData>(
      ['docs', '+fetch', '--doc', docUrl, '--scope', 'outline', '--doc-format', 'markdown', '--json'],
      READ_IDENTITY,
    );
    if (!res.ok || !res.data) return null;
    return res.data.document.revision_id ?? null;
  } catch {
    return null;
  }
}

/** Full content fetch (publish path only). Returns content plus revision. */
function fetchDoc(docUrl: string): { content: string; rev: number | null } {
  const res = lark<DocumentData>(
    ['docs', '+fetch', '--doc', docUrl, '--doc-format', 'markdown', '--json'],
    READ_IDENTITY,
  );
  if (!res.ok || !res.data) throw new Error(`failed to fetch doc (${docUrl}): ${res.error?.message}`);
  return {
    content: res.data.document.content ?? '',
    rev: res.data.document.revision_id ?? null,
  };
}

function downloadMedia(token: string, outPath: string): boolean {
  try {
    const res = lark<unknown>(
      ['docs', '+media-download', '--token', token, '--output', outPath, '--overwrite', '--json'],
      READ_IDENTITY,
    );
    return res.ok === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- helpers
const today = (): string => new Date().toISOString().slice(0, 10);

function toDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const m = String(v).match(/^\d{4}[-/]\d{2}[-/]\d{2}/);
  return m ? m[0].replaceAll('/', '-') : null;
}

function slugify(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Pure-CJK titles would produce ugly percent-encoded URLs; fall back to a
  // timestamp. Authors can always set the slug explicitly via the table.
  if (!/[a-z0-9]/.test(s)) return `post-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  return s || `post-${today()}`;
}

function firstParagraph(md: string): string {
  for (const block of md.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('!') || t.startsWith('|')) continue;
    const plain = t.replace(/[*_`>\-\[\]()]/g, '').replace(/\s+/g, ' ').trim();
    if (plain) return plain.length > 140 ? plain.slice(0, 139) + '…' : plain;
  }
  return '';
}

/** Replace Feishu image links with local paths; keep original on failure. */
function localizeImages(md: string, slug: string): { md: string; dir: string | null } {
  const dir = `images/blog/${slug}`;
  let n = 0;
  // wipe the article's image dir first so reordered/removed images leave no orphans
  if (/!\[[^\]]*\]\([^)]*(?:feishu|lark)/i.test(md) && !DRY) {
    rmSync(join(ROOT, 'public', dir), { recursive: true, force: true });
  }
  const out = md.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (whole: string, alt: string, target: string): string => {
      const token = target.match(/(?:file_token=|medias\/)([A-Za-z0-9_-]+)/)?.[1] ?? null;
      if (!token || !/feishu|lark/i.test(target)) return whole;
      n += 1;
      const name = String(n).padStart(2, '0');
      const dest = join(ROOT, 'public', dir, name);
      if (DRY) return `![${alt}](/${dir}/${name})`;
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
        if (downloadMedia(token, `${dest}.${ext}`)) return `![${alt}](/${dir}/${name}.${ext})`;
      }
      console.warn(`  warning: image download failed, keeping remote link: ${target}`);
      return whole;
    },
  );
  return { md: out, dir: n > 0 ? dir : null };
}

// ---------------------------------------------------------------- git
function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
}

function commitAndPush(message: string): void {
  if (DRY) {
    console.log(`  [dry-run] skip commit: ${message}`);
    return;
  }
  const status = git('status', '--porcelain');
  if (!status.trim()) {
    console.log('  no content changes, skip commit');
    return;
  }
  git('add', '-A');
  git('commit', '-m', message);
  if (!NO_PUSH) {
    git('push');
    console.log('  pushed; GitHub Actions will rebuild the site');
  } else {
    console.log('  committed locally (--no-push)');
  }
}

// ---------------------------------------------------------------- blog
function toBlogRow(r: RawRow): BlogRow {
  const tags = Array.isArray(r['标签']) ? (r['标签'] as string[]) : [];
  return {
    recordId: r._recordId,
    title: str(r['标题']),
    status: firstSelect(r['状态']),
    doc: str(r['文档']),
    slug: str(r['文件名']),
    summary: str(r['摘要']),
    author: str(r['作者']),
    date: r['发布日期'],
    tags,
    syncedRev: str(r['已同步版本']),
  };
}

function syncBlog(): void {
  console.log('\n=== Blog sync ===');
  const rows = fetchRows(BLOG_BASE, BLOG_TABLE).map(toBlogRow);
  console.log(`${rows.length} rows in table`);

  let published = 0, updated = 0, removed = 0, flagged = 0, same = 0, skipped = 0;
  const updates: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    // --- draft/empty: unpublish ---
    if (!row.status || row.status === S_DRAFT) {
      if (row.slug && existsSync(join(ROOT, 'src/content/blog', `${row.slug}.md`))) {
        console.log(`- unpublish: ${row.slug}`);
        if (!DRY) rmSync(join(ROOT, 'src/content/blog', `${row.slug}.md`));
        removed++;
      } else skipped++;
      continue;
    }

    if (!row.doc) {
      console.warn(`- skip (no doc link): ${row.title || row.recordId}`);
      skipped++;
      continue;
    }

    // --- updated: waiting for manual re-approval, do nothing ---
    if (row.status === S_STALE) {
      console.log(`- awaiting review (updated): ${row.title || row.doc}`);
      skipped++;
      continue;
    }

    // --- published: lightweight revision probe, never auto-republish ---
    if (row.status === S_LIVE) {
      const cur = probeRevision(row.doc);
      if (cur === null) {
        console.warn(`- probe failed (skipped, untouched): ${row.title || row.doc}`);
        skipped++;
      } else if (String(cur) !== row.syncedRev) {
        console.log(`- content changed -> flag as "${S_STALE}", awaiting manual confirm: ${row.title || row.doc}`);
        if (!DRY) updates[row.recordId] = { '状态': [S_STALE] };
        flagged++;
      } else {
        same++;
      }
      continue;
    }

    // --- pending: the only publish path ---
    if (row.status === S_PENDING) {
      const { content: rawContent, rev } = fetchDoc(row.doc);
      let content = rawContent;
      let docTitle = '';
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) {
        docTitle = h1[1].trim();
        content = content.replace(/^#\s+.+\n?/m, '');
      }
      const finalTitle = row.title || docTitle || 'Untitled';
      const slug = row.slug || slugify(finalTitle);
      const loc = localizeImages(content, slug);
      const date = toDate(row.date) ?? today();
      const desc = row.summary || firstParagraph(loc.md);
      const author = row.author || 'Fan Zhang';

      const fm = [
        '---',
        `title: ${JSON.stringify(finalTitle)}`,
        desc ? `description: ${JSON.stringify(desc)}` : null,
        `pubDate: ${date}`,
        `author: ${JSON.stringify(author)}`,
        `tags: ${JSON.stringify(row.tags)}`,
        '---',
      ]
        .filter(Boolean)
        .join('\n');

      const file = join(ROOT, 'src/content/blog', `${slug}.md`);
      const existed = existsSync(file);
      if (!DRY) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${fm}\n\n${loc.md.trim()}\n`);
      }
      console.log(`- ${existed ? 'update' : 'publish'}: ${finalTitle}  ->  /blogs/${slug}/`);
      existed ? updated++ : published++;

      const patch: Record<string, unknown> = { '状态': [S_LIVE] };
      if (!row.title) patch['标题'] = finalTitle;
      if (!row.slug) patch['文件名'] = slug;
      if (!row.summary) patch['摘要'] = desc;
      if (!row.date) patch['发布日期'] = Date.now(); // pin first-publish date
      if (rev !== null) patch['已同步版本'] = String(rev);
      patch['已发布链接'] = `${SITE_URL}/blogs/${slug}/`;
      if (!DRY) updates[row.recordId] = patch;
      continue;
    }

    skipped++;
  }

  if (Object.keys(updates).length && !DRY) {
    updateRecords(BLOG_BASE, BLOG_TABLE, updates);
    console.log(`  wrote back ${Object.keys(updates).length} rows`);
  }
  console.log(
    `summary: published ${published}, updated ${updated}, flagged ${flagged}, unchanged ${same}, unpublished ${removed}, skipped ${skipped}`,
  );
  if (published || updated || removed) {
    commitAndPush(`Sync blog from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
  }
}

// ---------------------------------------------------------------- publications
function syncPublications(): void {
  console.log('\n=== Publications sync ===');
  const rows = fetchRows(PUBS_BASE, PUBS_TABLE);
  const marked = rows.filter((r) => r['上网站'] === true);
  console.log(`${rows.length} rows in table, ${marked.length} marked for the site`);

  const pubs: Pub[] = marked
    .map((r) => ({
      title: typeof r['标题'] === 'string' ? r['标题'] : '',
      authors: typeof r['作者'] === 'string' ? r['作者'] : '',
      status: firstSelect(r['状态']) ?? '',
      venue: typeof r['期刊/会议'] === 'string' ? r['期刊/会议'] : '',
      year: typeof r['年份'] === 'number' ? (r['年份'] as number) : null,
      volume: typeof r['卷期页码'] === 'string' ? r['卷期页码'] : '',
      doi: typeof r['DOI'] === 'string' ? r['DOI'] : '',
      url: typeof r['链接'] === 'string' ? r['链接'] : '',
      tags: Array.isArray(r['标签']) ? (r['标签'] as string[]) : [],
    }))
    .filter((p) => p.title);

  pubs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

  const file = join(ROOT, 'src/data/publications.json');
  if (!DRY) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pubs, null, 2) + '\n');
  }
  console.log(`  wrote ${pubs.length} entries -> src/data/publications.json`);
  commitAndPush(`Sync publications from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
}

// ---------------------------------------------------------------- main
if (!['blog', 'publications', 'all'].includes(mode)) {
  console.error('usage: node scripts/sync.mts blog|publications|all [--no-push] [--dry-run]');
  process.exit(1);
}
if (DRY) console.log('(dry-run: no writes, no commits)');
if (mode === 'blog' || mode === 'all') syncBlog();
if (mode === 'publications' || mode === 'all') syncPublications();
console.log('\ndone.');
