#!/usr/bin/env node
/**
 * 飞书 → 官网 内容同步
 * 设计文档: docs/design/content-pipeline.md
 *
 * 用法:
 *   node scripts/sync.mjs blog [--no-push] [--dry-run]
 *   node scripts/sync.mjs publications [--no-push]
 *   node scripts/sync.mjs all [--no-push]
 *
 * 身份: 以用户身份(user)运行 —— 见设计文档 §6;
 * 读取用 lark-cli(本机已登录), 无需额外凭据。
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
const IDENTITY = 'user';
const SITE_URL = 'https://openearthmodelling.github.io';

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('-')) ?? 'all';
const NO_PUSH = args.includes('--no-push');
const DRY = args.includes('--dry-run');

// ---------------------------------------------------------------- lark-cli
function lark(cmdArgs) {
  const out = execFileSync('lark-cli', [...cmdArgs, '--as', IDENTITY], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 输出可能包含 _notice 等噪声行, 取第一个 { 开始的 JSON
  const i = out.indexOf('{');
  if (i < 0) throw new Error(`lark-cli 无 JSON 输出: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(i));
}

function fetchRows(baseToken, tableId) {
  const res = lark(['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--json']);
  if (!res.ok) throw new Error(`读取表格失败: ${res.error?.message}`);
  const d = res.data;
  const names = d.fields ?? [];
  const ids = d.record_id_list ?? [];
  return (d.data ?? []).map((row, i) => {
    const obj = { _recordId: ids[i] };
    names.forEach((n, j) => (obj[n] = row[j]));
    return obj;
  });
}

function updateRecords(baseToken, tableId, updates) {
  const res = lark([
    'base', '+record-batch-update',
    '--base-token', baseToken, '--table-id', tableId,
    '--json', JSON.stringify({ update_records: updates }),
  ]);
  if (!res.ok) throw new Error(`回写失败: ${res.error?.message}`);
  return res;
}

function fetchDocMarkdown(docUrl) {
  const res = lark(['docs', '+fetch', '--doc', docUrl, '--doc-format', 'markdown', '--json']);
  if (!res.ok) throw new Error(`拉取文档失败(${docUrl}): ${res.error?.message}`);
  return res.data.document.content ?? '';
}

function downloadMedia(token, outPath) {
  const res = lark(['docs', '+media-download', '--token', token, '--output', outPath, '--overwrite', '--json']);
  return res.ok === true;
}

// ---------------------------------------------------------------- helpers
const today = () => new Date().toISOString().slice(0, 10);

function firstSelect(v) {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^\d{4}[-/]\d{2}[-/]\d{2}/);
  return m ? m[0].replaceAll('/', '-') : null;
}

function slugify(title) {
  const s = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || `post-${today()}`;
}

function firstParagraph(md) {
  for (const block of md.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('!') || t.startsWith('|')) continue;
    const plain = t.replace(/[*_`>\-\[\]()]/g, '').replace(/\s+/g, ' ').trim();
    if (plain) return plain.length > 140 ? plain.slice(0, 139) + '…' : plain;
  }
  return '';
}

// 把 markdown 里的飞书图片换成站内路径; 下载失败则保留原样并告警
function localizeImages(md, slug) {
  const dir = `images/blog/${slug}`;
  let n = 0;
  // 先清空该文章的图片目录, 防止飞书端增删/换序图片后旧文件残留
  if (/!\[[^\]]*\]\([^)]*(?:feishu|lark)/i.test(md) && !DRY) {
    rmSync(join(ROOT, 'public', dir), { recursive: true, force: true });
  }
  const out = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, target) => {
    const token = target.match(/(?:file_token=|medias\/)([A-Za-z0-9_-]+)/)?.[1] ?? null;
    if (!token || !/feishu|lark/i.test(target)) return whole;
    n += 1;
    const name = `${String(n).padStart(2, '0')}`;
    const dest = join(ROOT, 'public', dir, name);
    if (DRY) return `![${alt}](/${dir}/${name})`; // dry-run 不落盘
    let ok = false;
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      if (downloadMedia(token, `${dest}.${ext}`)) { ok = true; return `![${alt}](/${dir}/${name}.${ext})`; }
    }
    if (!ok) console.warn(`  ⚠ 图片下载失败, 保留原链接: ${target}`);
    return whole;
  });
  return { md: out, dir: n ? dir : null };
}

// ---------------------------------------------------------------- git
function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
}

function commitAndPush(message) {
  if (DRY) { console.log(`  [dry-run] 跳过提交: ${message}`); return; }
  const status = git('status', '--porcelain');
  if (!status.trim()) { console.log('  无内容变化, 跳过提交'); return; }
  git('add', '-A');
  git('commit', '-m', message);
  if (!NO_PUSH) { git('push'); console.log('  已推送, GitHub Actions 将自动构建上线'); }
  else console.log('  已本地提交(--no-push, 未推送)');
}

// ---------------------------------------------------------------- blog
function syncBlog() {
  console.log('\n=== Blog 同步 ===');
  const rows = fetchRows(BLOG_BASE, BLOG_TABLE);
  console.log(`表中 ${rows.length} 行`);

  let published = 0, updated = 0, removed = 0, skipped = 0;
  const updates = {};

  for (const row of rows) {
    const title = row['标题']?.trim?.() ?? '';
    const status = firstSelect(row['状态']);
    const doc = row['文档']?.trim?.() ?? '';
    const slugField = row['文件名']?.trim?.() ?? '';

    if (!status || status === '草稿') {
      // 下架: 曾有文件名则删除对应文章
      if (slugField && existsSync(join(ROOT, 'src/content/blog', `${slugField}.md`))) {
        console.log(`- 下架: ${slugField}`);
        if (!DRY) rmSync(join(ROOT, 'src/content/blog', `${slugField}.md`));
        removed++;
      } else skipped++;
      continue;
    }
    if (status !== '待发布' && status !== '已发布') { skipped++; continue; }
    if (!doc) { console.warn(`- 跳过(无文档链接): ${title || row._recordId}`); skipped++; continue; }

    // 拉正文
    let content = fetchDocMarkdown(doc);
    // 文档首个 H1 即标题(飞书导出行为), 剥离后用作标题兜底
    let docTitle = '';
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) { docTitle = h1[1].trim(); content = content.replace(/^#\s+.+\n?/m, ''); }
    const finalTitle = title || docTitle || 'Untitled';

    const slug = slugField || slugify(finalTitle);
    const loc = localizeImages(content, slug);
    const date = toDate(row['发布日期']) ?? today();
    const desc = row['摘要']?.trim?.() || firstParagraph(loc.md);
    const author = row['作者']?.trim?.() || 'Fan Zhang';
    const tags = Array.isArray(row['标签']) ? row['标签'] : [];

    const fm = [
      '---',
      `title: ${JSON.stringify(finalTitle)}`,
      desc ? `description: ${JSON.stringify(desc)}` : null,
      `pubDate: ${date}`,
      `author: ${JSON.stringify(author)}`,
      `tags: ${JSON.stringify(tags)}`,
      '---',
    ].filter(Boolean).join('\n');

    const file = join(ROOT, 'src/content/blog', `${slug}.md`);
    const existed = existsSync(file);
    if (!DRY) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${fm}\n\n${loc.md.trim()}\n`);
    }
    console.log(`- ${existed ? '更新' : '发布'}: ${finalTitle}  →  /blogs/${slug}/`);
    existed ? updated++ : published++;

    // 回写(仅填空字段 + 状态置已发布)
    const patch = {};
    if (status === '待发布') patch['状态'] = ['已发布'];
    if (!title) patch['标题'] = finalTitle;
    if (!slugField) patch['文件名'] = slug;
    if (!row['摘要']) patch['摘要'] = desc;
    if (!row['发布日期']) patch['发布日期'] = Date.now(); // 钉住首次发布日期, 防止后续同步漂移
    patch['已发布链接'] = `${SITE_URL}/blogs/${slug}/`;
    updates[row._recordId] = patch;
  }

  if (Object.keys(updates).length && !DRY) {
    updateRecords(BLOG_BASE, BLOG_TABLE, updates);
    console.log(`  回写 ${Object.keys(updates).length} 行`);
  }
  console.log(`结果: 新发布 ${published}, 更新 ${updated}, 下架 ${removed}, 跳过 ${skipped}`);
  if (published || updated || removed) {
    commitAndPush(`Sync blog from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
  }
}

// ---------------------------------------------------------------- publications
function syncPublications() {
  console.log('\n=== Publications 同步 ===');
  const rows = fetchRows(PUBS_BASE, PUBS_TABLE);
  const marked = rows.filter((r) => r['上网站'] === true);
  console.log(`表中 ${rows.length} 行, 勾选上网站 ${marked.length} 行`);

  const pubs = marked.map((r) => ({
    title: r['标题'] ?? '',
    authors: r['作者'] ?? '',
    status: firstSelect(r['状态']) ?? '',
    venue: r['期刊/会议'] ?? '',
    year: typeof r['年份'] === 'number' ? r['年份'] : null,
    volume: r['卷期页码'] ?? '',
    doi: r['DOI'] ?? '',
    url: r['链接'] ?? '',
    tags: Array.isArray(r['标签']) ? r['标签'] : [],
  })).filter((p) => p.title);

  pubs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

  const file = join(ROOT, 'src/data/publications.json');
  const json = JSON.stringify(pubs, null, 2) + '\n';
  if (!DRY) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, json);
  }
  console.log(`  写入 ${pubs.length} 条 → src/data/publications.json`);
  commitAndPush(`Sync publications from Feishu (${new Date().toISOString().slice(0, 16)}Z)`);
}

// ---------------------------------------------------------------- main
if (!['blog', 'publications', 'all'].includes(mode)) {
  console.error('用法: node scripts/sync.mjs blog|publications|all [--no-push] [--dry-run]');
  process.exit(1);
}
if (DRY) console.log('(dry-run 模式: 不落盘/不提交)');
if (mode === 'blog' || mode === 'all') syncBlog();
if (mode === 'publications' || mode === 'all') syncPublications();
console.log('\n完成。');
