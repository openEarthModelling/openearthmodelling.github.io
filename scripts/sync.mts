#!/usr/bin/env node
/**
 * 飞书 → 官网 内容同步(TypeScript,Node >= 23.6 原生运行,无需编译)
 * 设计文档: docs/design/content-pipeline.md
 *
 * 状态机(手动闸门,方案一):
 *   草稿        = 不上站(已发布的会下架)
 *   待发布      = 发布指令,唯一触发器,只能由人手动设置
 *   已发布      = 线上在架;同步只做轻量版本探测,内容变化则翻成"有更新"
 *   有更新      = 在架但飞书内容已变,等人工复核(选回"待发布"才会重新发布)
 *
 * 身份分工(见设计文档 §6):
 *   文档读取/图片下载 → bot(应用身份,知识库成员)
 *   表格读写         → user(知识库管理员)
 *
 * 用法:
 *   node scripts/sync.mts blog|publications|all [--no-push] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 飞书侧常量 ----
const BLOG_BASE = 'C4UHb2txzaU5IDsWrd2cGr7qnHe';
const BLOG_TABLE = 'tblFnCEsTkKjwRAl';
const PUBS_BASE = 'NRYTbayjcaD48asba8CcNyHined';
const PUBS_TABLE = 'tblwuIiPOZshexEC';
const DOC_IDENTITY = 'bot'; // 文档/媒体读取
const TABLE_IDENTITY = 'user'; // 表格读写
const SITE_URL = 'https://openearthmodelling.github.io';

// ---- 状态机常量 ----
const S_DRAFT = '草稿';
const S_PENDING = '待发布';
const S_LIVE = '已发布';
const S_STALE = '有更新';

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
  if (i < 0) throw new Error(`lark-cli 无 JSON 输出: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(i)) as LarkEnvelope<T>;
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';
const firstSelect = (v: unknown): string | null =>
  Array.isArray(v) ? ((v[0] as string) ?? null) : ((v as string) ?? null);

function fetchRows(baseToken: string, tableId: string): RawRow[] {
  const res = lark<RecordListData>(
    ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--json'],
    TABLE_IDENTITY,
  );
  if (!res.ok || !res.data) throw new Error(`读取表格失败: ${res.error?.message}`);
  const names = res.data.fields ?? [];
  const ids = res.data.record_id_list ?? [];
  return (res.data.data ?? []).map((row, i) => {
    const obj: RawRow = { _recordId: ids[i] ?? '' };
    names.forEach((n, j) => (obj[n] = row[j]));
    return obj;
  });
}

function updateRecords(baseToken: string, tableId: string, updates: Record<string, Record<string, unknown>>): void {
  const res = lark<unknown>(
    [
      'base', '+record-batch-update',
      '--base-token', baseToken, '--table-id', tableId,
      '--json', JSON.stringify({ update_records: updates }),
    ],
    TABLE_IDENTITY,
  );
  if (!res.ok) throw new Error(`回写失败: ${res.error?.message}`);
}

/** 轻量版本探测:只拉标题目录,返回当前 revision_id */
function probeRevision(docUrl: string): number | null {
  try {
    const res = lark<DocumentData>(
      ['docs', '+fetch', '--doc', docUrl, '--scope', 'outline', '--doc-format', 'markdown', '--json'],
      DOC_IDENTITY,
    );
    if (!res.ok || !res.data) return null;
    return res.data.document.revision_id ?? null;
  } catch {
    return null;
  }
}

/** 全量拉取正文(仅发布路径使用),返回正文与版本号 */
function fetchDoc(docUrl: string): { content: string; rev: number | null } {
  const res = lark<DocumentData>(
    ['docs', '+fetch', '--doc', docUrl, '--doc-format', 'markdown', '--json'],
    DOC_IDENTITY,
  );
  if (!res.ok || !res.data) throw new Error(`拉取文档失败(${docUrl}): ${res.error?.message}`);
  return {
    content: res.data.document.content ?? '',
    rev: res.data.document.revision_id ?? null,
  };
}

function downloadMedia(token: string, outPath: string): boolean {
  try {
    const res = lark<unknown>(
      ['docs', '+media-download', '--token', token, '--output', outPath, '--overwrite', '--json'],
      DOC_IDENTITY,
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
  // 纯 CJK 标题会产生难看的百分号编码 URL, 用时间戳兜底; 手动填"文件名"字段可覆盖
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

/** 把 markdown 里的飞书图片换成站内路径;下载失败保留原链接并告警 */
function localizeImages(md: string, slug: string): { md: string; dir: string | null } {
  const dir = `images/blog/${slug}`;
  let n = 0;
  // 先清空该文章的图片目录, 防止飞书端增删/换序图片后旧文件残留
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
      console.warn(`  ⚠ 图片下载失败, 保留原链接: ${target}`);
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
    console.log(`  [dry-run] 跳过提交: ${message}`);
    return;
  }
  const status = git('status', '--porcelain');
  if (!status.trim()) {
    console.log('  无内容变化, 跳过提交');
    return;
  }
  git('add', '-A');
  git('commit', '-m', message);
  if (!NO_PUSH) {
    git('push');
    console.log('  已推送, GitHub Actions 将自动构建上线');
  } else {
    console.log('  已本地提交(--no-push, 未推送)');
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
  console.log('\n=== Blog 同步 ===');
  const rows = fetchRows(BLOG_BASE, BLOG_TABLE).map(toBlogRow);
  console.log(`表中 ${rows.length} 行`);

  let published = 0, updated = 0, removed = 0, flagged = 0, same = 0, skipped = 0;
  const updates: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    // --- 草稿/空:下架 ---
    if (!row.status || row.status === S_DRAFT) {
      if (row.slug && existsSync(join(ROOT, 'src/content/blog', `${row.slug}.md`))) {
        console.log(`- 下架: ${row.slug}`);
        if (!DRY) rmSync(join(ROOT, 'src/content/blog', `${row.slug}.md`));
        removed++;
      } else skipped++;
      continue;
    }

    if (!row.doc) {
      console.warn(`- 跳过(无文档链接): ${row.title || row.recordId}`);
      skipped++;
      continue;
    }

    // --- 有更新:等待人工复核,什么都不做 ---
    if (row.status === S_STALE) {
      console.log(`- 待复核(有更新): ${row.title || row.doc}`);
      skipped++;
      continue;
    }

    // --- 已发布:轻量版本探测,变化则翻"有更新",绝不自动重发 ---
    if (row.status === S_LIVE) {
      const cur = probeRevision(row.doc);
      if (cur === null) {
        console.warn(`- 探测失败(跳过,不改动): ${row.title || row.doc}`);
        skipped++;
      } else if (String(cur) !== row.syncedRev) {
        console.log(`- 内容有变化 → 标记"有更新",等人工确认: ${row.title || row.doc}`);
        if (!DRY) updates[row.recordId] = { '状态': [S_STALE] };
        flagged++;
      } else {
        same++;
      }
      continue;
    }

    // --- 待发布:唯一发布路径 ---
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
      console.log(`- ${existed ? '更新' : '发布'}: ${finalTitle}  →  /blogs/${slug}/`);
      existed ? updated++ : published++;

      const patch: Record<string, unknown> = { '状态': [S_LIVE] };
      if (!row.title) patch['标题'] = finalTitle;
      if (!row.slug) patch['文件名'] = slug;
      if (!row.summary) patch['摘要'] = desc;
      if (!row.date) patch['发布日期'] = Date.now(); // 钉住首次发布日期
      if (rev !== null) patch['已同步版本'] = String(rev);
      patch['已发布链接'] = `${SITE_URL}/blogs/${slug}/`;
      if (!DRY) updates[row.recordId] = patch;
      continue;
    }

    skipped++;
  }

  if (Object.keys(updates).length && !DRY) {
    updateRecords(BLOG_BASE, BLOG_TABLE, updates);
    console.log(`  回写 ${Object.keys(updates).length} 行`);
  }
  console.log(
    `结果: 新发布 ${published}, 更新 ${updated}, 标记有更新 ${flagged}, 无变化 ${same}, 下架 ${removed}, 跳过 ${skipped}`,
  );
  if (published || updated || removed) {
    commitAndPush(`Sync blog from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
  }
}

// ---------------------------------------------------------------- publications
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

function syncPublications(): void {
  console.log('\n=== Publications 同步 ===');
  const rows = fetchRows(PUBS_BASE, PUBS_TABLE);
  const marked = rows.filter((r) => r['上网站'] === true);
  console.log(`表中 ${rows.length} 行, 勾选上网站 ${marked.length} 行`);

  const pubs: Pub[] = marked.map((r) => ({
    title: typeof r['标题'] === 'string' ? r['标题'] : '',
    authors: typeof r['作者'] === 'string' ? r['作者'] : '',
    status: firstSelect(r['状态']) ?? '',
    venue: typeof r['期刊/会议'] === 'string' ? r['期刊/会议'] : '',
    year: typeof r['年份'] === 'number' ? (r['年份'] as number) : null,
    volume: typeof r['卷期页码'] === 'string' ? r['卷期页码'] : '',
    doi: typeof r['DOI'] === 'string' ? r['DOI'] : '',
    url: typeof r['链接'] === 'string' ? r['链接'] : '',
    tags: Array.isArray(r['标签']) ? (r['标签'] as string[]) : [],
  })).filter((p) => p.title);

  pubs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

  const file = join(ROOT, 'src/data/publications.json');
  if (!DRY) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pubs, null, 2) + '\n');
  }
  console.log(`  写入 ${pubs.length} 条 → src/data/publications.json`);
  commitAndPush(`Sync publications from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
}

// ---------------------------------------------------------------- main
if (!['blog', 'publications', 'all'].includes(mode)) {
  console.error('用法: node scripts/sync.mts blog|publications|all [--no-push] [--dry-run]');
  process.exit(1);
}
if (DRY) console.log('(dry-run 模式: 不落盘/不回写/不提交)');
if (mode === 'blog' || mode === 'all') syncBlog();
if (mode === 'publications' || mode === 'all') syncPublications();
console.log('\n完成。');
