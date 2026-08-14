// weread-sync.js — 微信读书 → Agent-Library 同步脚本（人机共读桥）
// 用法：
//   node weread-sync.js list                          # 列出有笔记的书
//   node weread-sync.js validate <bookId> <epub路径>   # 锚定测试（质量门槛）
//   node weread-sync.js upload <bookId> <epub路径>     # 上传书+笔记到 AL
// 环境变量：WEREAD_API_KEY, AL_BASE(默认http://localhost:3000), AL_AGENT(默认human)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.WEREAD_API_KEY;
if (!KEY) { console.error("需要 WEREAD_API_KEY 环境变量（wrk- 开头）"); process.exit(1); }
const AL_BASE = process.env.AL_BASE || "http://localhost:3000";
const AL_AGENT = process.env.AL_AGENT || "human";
const PANDOC = "D:/fs/70_Software/pandoc/pandoc.exe";
const SKILL_VER = "1.0.4";

// ---------- 微信读书网关 ----------
async function weread(apiName, params = {}) {
  const res = await fetch("https://i.weread.qq.com/api/agent/gateway", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VER }),
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`weread ${apiName} 错误: ${data.errcode} ${data.msg || ""}`);
  return data;
}

// 全量笔记本（游标翻页）
async function listNotebooks() {
  const all = [];
  let lastSort;
  let hasMore = 1;
  while (hasMore) {
    const page = await weread("/user/notebooks", lastSort ? { count: 50, lastSort } : { count: 50 });
    all.push(...(page.books || []));
    hasMore = page.hasMore;
    lastSort = page.books?.length ? page.books[page.books.length - 1].sort : undefined;
    if (!hasMore) break;
  }
  return all;
}

// 拉一本书的笔记（划线 + 想法）
async function fetchNotes(bookId) {
  const [bm, rv] = await Promise.all([
    weread("/book/bookmarklist", { bookId }),
    weread("/review/list/mine", { bookid: bookId, synckey: 0, count: 200 }),
  ]);
  return {
    underlines: (bm.updated || []).map((u) => ({
      sourceId: u.bookmarkId, markText: u.markText, range: u.range,
      chapterUid: u.chapterUid, createTime: u.createTime, colorStyle: u.colorStyle,
    })),
    reviews: (rv.reviews || []).map((r) => ({
      sourceId: r.review?.reviewId, content: r.review?.content, abstract: r.review?.abstract,
      range: r.review?.range, chapterUid: r.review?.chapterUid, star: r.review?.star,
      createTime: r.review?.createTime,
    })),
    chapters: bm.chapters || [],
  };
}

// ---------- epub → md ----------
function epubToMd(epubPath) {
  const tmp = path.join(path.dirname(epubPath), `_tmp_${Date.now()}.md`);
  execSync(`"${PANDOC}" "${epubPath}" -t gfm -o "${tmp}"`, { stdio: "pipe" });
  const md = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  return md;
}

// ---------- 锚定 ----------
// 把 md 转成 AL 段落结构（非空行），并构建"归一化全文→段落"索引
function buildParagraphs(md) {
  const paragraphs = md.split(/\r?\n/).filter((p) => p.trim().length > 0).map((p) => p.trim());
  // 归一化全文（去空白）→ 每字符对应的段落（用于 markText 偏移换算）
  const norm = [];
  const paraOfChar = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const t = paragraphs[i].replace(/\s+/g, "");
    for (let j = 0; j < t.length; j++) {
      norm.push(t[j]);
      paraOfChar.push(i);
    }
  }
  return { paragraphs, normStr: norm.join(""), paraOfChar };
}

// 在 md 里定位一条文本，返回 { paragraph, start_char, end_char } 或 null
// start_char/end_char 是段内偏移（符合 AL 字符级锚定语义）
function anchorInParagraph(paragraphs, markText) {
  const t = markText.replace(/\s+/g, "");
  for (let i = 0; i < paragraphs.length; i++) {
    const pNorm = paragraphs[i].replace(/\s+/g, "");
    const idx = pNorm.indexOf(t);
    if (idx >= 0) return { paragraph: i, start_char: idx, end_char: idx + t.length };
  }
  return null;
}

// ---------- AL API ----------
async function alApi(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(AL_BASE + url, opts);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 80) }; }
  return { status: res.status, data };
}

// 上传 md 作为书（需 agent 身份）；source/source_id 标记来源并幂等
async function uploadBook(title, md, sourceId) {
  const form = new FormData();
  form.append("file", new Blob([md], { type: "text/markdown" }), "book.md");
  form.append("title", title);
  form.append("agent", AL_AGENT);
  form.append("source", "weread");
  form.append("source_id", sourceId);
  const res = await fetch(`${AL_BASE}/api/books`, { method: "POST", body: form });
  const data = await res.json();
  return { status: res.status, data };
}

// ---------- 子命令 ----------
async function cmdList() {
  const books = await listNotebooks();
  console.log("有笔记的书：");
  for (const b of books) {
    console.log(`  ${b.bookId}  ${b.book?.title}  划线${b.noteCount}/想法${b.reviewCount}/书签${b.bookmarkCount}  format=${b.book?.format}`);
  }
}

async function cmdValidate(bookId, epubPath) {
  const notes = await fetchNotes(bookId);
  const md = epubToMd(epubPath);
  const { paragraphs } = buildParagraphs(md);
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  let hit = 0;
  for (const s of samples.slice(0, 20)) {
    if (anchorInParagraph(paragraphs, s.markText)) hit++;
  }
  const total = Math.min(samples.length, 20);
  const rate = total ? Math.round((hit / total) * 100) : 0;
  console.log(`锚定测试：${hit}/${total} 命中（${rate}%），${total === 0 ? "无笔记样本" : rate >= 90 ? "✅ 同版，可上传" : "❌ 版本不一致，拒绝"}`);
  return rate >= 90;
}

async function cmdUpload(bookId, epubPath) {
  // 1. 先 validate
  const notes = await fetchNotes(bookId);
  const md = epubToMd(epubPath);
  const { paragraphs } = buildParagraphs(md);
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  let hit = 0;
  for (const s of samples.slice(0, 20)) if (anchorInParagraph(paragraphs, s.markText)) hit++;
  const total = Math.min(samples.length, 20);
  const rate = total ? Math.round((hit / total) * 100) : 0;
  if (rate < 90) { console.error(`锚定率 ${rate}% < 90%，拒绝上传（版本可能不一致）`); process.exit(1); }
  console.log(`锚定 ${hit}/${total}（${rate}%）通过，开始上传`);

  // 2. 上传书（source_id 幂等：已存在则返回已有书，跳过重传）
  const info = await weread("/book/info", { bookId });
  const title = info.title || path.basename(epubPath);
  const up = await uploadBook(title, md, bookId);
  if (up.status !== 201 && !up.data.exists) { console.error("上传书失败:", JSON.stringify(up.data)); process.exit(1); }
  const bookIdAl = up.data.id;
  console.log(`书已上传: id=${bookIdAl} title=${title}${up.data.exists ? "（已存在，复用）" : ""}`);

  // 3. 映射笔记 → 划线/批注
  let hlOk = 0, hlSkip = 0, noteOk = 0, noteSkip = 0;
  for (const u of notes.underlines) {
    const a = anchorInParagraph(paragraphs, u.markText);
    if (!a) { hlSkip++; continue; }
    const r = await alApi("POST", `/api/books/${bookIdAl}/highlights`, {
      paragraph: a.paragraph, text: u.markText.slice(0, 200), agent: AL_AGENT,
      start_char: a.start_char, end_char: a.end_char, color: "yellow", source_id: u.sourceId,
    });
    if (r.status === 201) hlOk++; else hlSkip++;
  }
  for (const rv of notes.reviews) {
    // 想法：有 abstract（锚定原文）→ 批注；否则挂段落0
    let a = null;
    if (rv.abstract) a = anchorInParagraph(paragraphs, rv.abstract);
    const body = { paragraph: a?.paragraph ?? 0, content: rv.content, agent: AL_AGENT, source_id: rv.sourceId };
    if (a) { body.start_char = a.start_char; body.end_char = a.end_char; }
    const r = await alApi("POST", `/api/books/${bookIdAl}/notes`, body);
    if (r.status === 201) noteOk++; else noteSkip++;
  }
  console.log(`划线: ${hlOk} 成功 / ${hlSkip} 跳过(锚定失败或去重)`);
  console.log(`想法: ${noteOk} 成功 / ${noteSkip} 跳过`);
  console.log("完成。可在 AL 里阅读并回复。");
}

// ---------- 入口 ----------
const cmd = process.argv[2];
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "validate" || cmd === "upload") {
    // 支持按 bookId 自动匹配 ebooks 目录里的本地 epub（避免命令行中文路径编码问题）
    const bookId = process.argv[3];
    let epubPath = process.argv[4];
    if (!epubPath) {
      // 从微信读书书名找 ebooks 目录下的 epub（模糊：取书名前若干字符）
      const info = await weread("/book/info", { bookId });
      const candidates = fs.readdirSync("D:/ws/agent_library/ebooks").filter((f) => f.endsWith(".epub"));
      const guess = candidates.find((f) => info.title && f.includes(info.title.slice(0, 4)));
      if (guess) epubPath = "D:/ws/agent_library/ebooks/" + guess;
      if (!epubPath) { console.error(`未找到 ${info.title} 的本地 epub，请手动指定路径`); process.exit(1); }
    }
    if (cmd === "validate") await cmdValidate(bookId, epubPath);
    else await cmdUpload(bookId, epubPath);
  }
  else { console.log("用法: node weread-sync.js <list|validate|upload> <bookId> [epub路径]"); process.exit(1); }
} catch (e) {
  console.error("错误:", e.message);
  process.exit(1);
}
