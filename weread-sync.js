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
// 工具与目录路径可配（服务器 Linux 用 /usr/bin/pandoc、ebook-convert，ebooks 目录按需设）
const PANDOC = process.env.PANDOC_PATH || "D:/fs/70_Software/pandoc/pandoc.exe";
const EBOOK_CONVERT = process.env.EBOOK_CONVERT_PATH || "D:/fs/70_Software/calibre/ebook-convert.exe";
const EBOOKS_DIR = process.env.EBOOKS_DIR || path.join(import.meta.dirname, "ebooks");
const SKILL_VER = "1.0.4";
const STATE_FILE = path.join(import.meta.dirname, ".weread-state.json");

// ---------- 增量同步状态 ----------
// 记录每本书上次同步时间戳（按 createTime），下次只拉新笔记。
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function lastSyncOf(state, bookId) {
  const t = state[bookId]?.lastSync;
  return typeof t === "number" ? t : 0;
}

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

// ---------- 转 md ----------
// epub/mobi → md：epub 用 pandoc，mobi 用 calibre ebook-convert（先转 txt 再直接用）
function convertToMd(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mobi" || ext === ".azw3") {
    const out = path.join(path.dirname(filePath), `_tmp_${Date.now()}.txt`);
    execSync(`"${EBOOK_CONVERT}" "${filePath}" "${out}"`, { stdio: "pipe", timeout: 300000 });
    const txt = fs.readFileSync(out, "utf8");
    fs.unlinkSync(out);
    return txt;
  }
  // epub / 其他 → pandoc
  const tmp = path.join(path.dirname(filePath), `_tmp_${Date.now()}.md`);
  execSync(`"${PANDOC}" "${filePath}" -t gfm -o "${tmp}"`, { stdio: "pipe" });
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
// 策略：归一化（去空白 + 去 markdown 标记 + 统一标点）后，在"全文拼接串"里做子串匹配，
// 支持跨段划线；返回起始段 + 段内偏移（符合 AL 字符级锚定语义）。
function normalize(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "") // 去 markdown 标记
    .replace(/\s+/g, "")
    .replace(/[\u201c\u201d""]/g, '"').replace(/[\u2018\u2019'']/g, "'")
    .replace(/[\u3000\u00a0]/g, "");
}

function anchorInParagraph(paragraphs, markText) {
  const n = normalize(markText);
  if (!n) return null;
  // 优先单段匹配（快路径）
  for (let i = 0; i < paragraphs.length; i++) {
    const pn = normalize(paragraphs[i]);
    const idx = pn.indexOf(n);
    if (idx >= 0) return { paragraph: i, start_char: idx, end_char: idx + n.length };
  }
  // 全文拼接匹配（跨段划线）
  const full = [];
  const paraOf = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const pn = normalize(paragraphs[i]);
    for (let j = 0; j < pn.length; j++) { full.push(pn[j]); paraOf.push(i); }
  }
  const fullStr = full.join("");
  const idx = fullStr.indexOf(n);
  if (idx < 0) return null;
  const startPara = paraOf[idx];
  // 起始段内偏移：累加 startPara 之前段落长度得到全文偏移起点，再换算段内
  let acc = 0;
  for (let i = 0; i < startPara; i++) acc += normalize(paragraphs[i]).length;
  const segStart = idx - acc; // 起始段内偏移
  const paraLen = normalize(paragraphs[startPara]).length;
  // 跨段时截断到起始段末尾（AL 划线限单段字符范围）
  const end = Math.min(segStart + n.length, paraLen);
  if (end <= segStart) return null;
  return { paragraph: startPara, start_char: segStart, end_char: end };
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
  const md = convertToMd(epubPath);

  const { paragraphs } = buildParagraphs(md);
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  // 全量锚定率统计（比抽前20条稳定）
  let hit = 0;
  for (const s of samples) {
    if (anchorInParagraph(paragraphs, s.markText)) hit++;
  }
  const total = samples.length;
  const rate = total ? Math.round((hit / total) * 100) : 0;
  console.log(`锚定测试：${hit}/${total} 命中（${rate}%），${total === 0 ? "无笔记样本" : rate >= 85 ? "✅ 同版，可上传" : "❌ 版本不一致，拒绝"}`);
  return rate >= 85;
}

async function cmdUpload(bookId, epubPath) {
  // 1. 先 validate
  const notes = await fetchNotes(bookId);
  const md = convertToMd(epubPath);

  const { paragraphs } = buildParagraphs(md);
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  // 全量锚定率
  let hit = 0;
  for (const s of samples) if (anchorInParagraph(paragraphs, s.markText)) hit++;
  const total = samples.length;
  const rate = total ? Math.round((hit / total) * 100) : 0;
  if (rate < 85) { console.error(`锚定率 ${rate}% < 85%，拒绝上传（版本可能不一致）`); process.exit(1); }
  console.log(`锚定 ${hit}/${total}（${rate}%）通过，开始上传`);

  // 2. 上传书（source_id 幂等：已存在则返回已有书，跳过重传）
  const info = await weread("/book/info", { bookId });
  const title = info.title || path.basename(epubPath);
  const up = await uploadBook(title, md, bookId);
  if (up.status !== 201 && !up.data.exists) { console.error("上传书失败:", JSON.stringify(up.data)); process.exit(1); }
  const bookIdAl = up.data.id;
  console.log(`书已上传: id=${bookIdAl} title=${title}${up.data.exists ? "（已存在，复用）" : ""}`);

  // 2.5 增量：只同步上次之后的新笔记
  const state = readState();
  const lastSync = lastSyncOf(state, bookId);
  let newUnderlines = notes.underlines;
  let newReviews = notes.reviews;
  if (lastSync > 0) {
    newUnderlines = notes.underlines.filter((u) => (u.createTime || 0) > lastSync);
    newReviews = notes.reviews.filter((r) => (r.createTime || 0) > lastSync);
    console.log(`增量同步（上次 ${new Date(lastSync * 1000).toISOString().slice(0, 10)}）：新划线 ${newUnderlines.length} / 新想法 ${newReviews.length}`);
  }

  // 3. 映射笔记 → 划线/批注（锚定失败也上传，挂段落0兜底归位，便于后续人工/Agent 处理）
  let hlOk = 0, hlSkip = 0, noteOk = 0, noteSkip = 0, hlFallback = 0, noteFallback = 0;
  for (const u of newUnderlines) {
    const a = anchorInParagraph(paragraphs, u.markText);
    if (!a) {
      // 兜底：锚定失败的划线上传为"待归位"批注（挂段落0，content 标记原文）
      const fb = await alApi("POST", `/api/books/${bookIdAl}/notes`, {
        paragraph: 0, content: `[微信划线·待归位] ${u.markText.slice(0, 150)}`, agent: AL_AGENT, source_id: u.sourceId,
      });
      if (fb.status === 201) { hlFallback++; } else { hlSkip++; }
      continue;
    }
    const r = await alApi("POST", `/api/books/${bookIdAl}/highlights`, {
      paragraph: a.paragraph, text: u.markText.slice(0, 200), agent: AL_AGENT,
      start_char: a.start_char, end_char: a.end_char, color: "yellow", source_id: u.sourceId,
    });
    if (r.status === 201) hlOk++; else hlSkip++;
  }
  for (const rv of newReviews) {
    // 想法：有 abstract（锚定原文）→ 批注；否则挂段落0
    let a = null;
    if (rv.abstract) a = anchorInParagraph(paragraphs, rv.abstract);
    const body = { paragraph: a?.paragraph ?? 0, content: rv.content, agent: AL_AGENT, source_id: rv.sourceId };
    if (a) { body.start_char = a.start_char; body.end_char = a.end_char; } else { noteFallback++; }
    const r = await alApi("POST", `/api/books/${bookIdAl}/notes`, body);
    if (r.status === 201) noteOk++; else noteSkip++;
  }
  // 4. 记录同步状态（取本次同步笔记的最大 createTime）
  const maxT = Math.max(...notes.underlines.map((u) => u.createTime || 0), ...notes.reviews.map((r) => r.createTime || 0));
  if (maxT > 0) {
    state[bookId] = { lastSync: maxT, title };
    writeState(state);
  }
  console.log(`划线: ${hlOk} 成功 / ${hlFallback} 待归位 / ${hlSkip} 跳过(去重)`);
  console.log(`想法: ${noteOk} 成功 / ${noteFallback} 挂段落0 / ${noteSkip} 跳过`);
  console.log("完成。可在 AL 里阅读并回复。");
}

// ---------- 交互式引导模式（M6） ----------
// 无参数运行：列出有笔记的书 → 选书 → 场景二(自动传书+笔记) 或 场景一(挂已有AL书)
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function cmdInteractive() {
  console.log("=== 微信读书 → Agent-Library 同步（交互式）===\n");
  // 1. 列出有笔记的书
  const books = await listNotebooks();
  const list = books.filter((b) => b.noteCount + b.reviewCount > 0);
  console.log(`你有笔记的书（${list.length} 本）：`);
  list.slice(0, 30).forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.book?.title?.slice(0, 30)}  划线${b.noteCount}/想法${b.reviewCount}`);
  });
  if (list.length > 30) console.log(`  ... 还有 ${list.length - 30} 本`);
  const pick = await ask("\n选择编号（或 q 退出）：");
  if (pick.toLowerCase() === "q") { rl.close(); return; }
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= list.length) { console.log("无效选择"); rl.close(); return; }
  const book = list[idx];
  const bookId = book.bookId;
  console.log(`\n已选: ${book.book?.title} (${bookId})`);

  // 2. 场景选择：挂已有 AL 书 / 新建上传
  const already = await findAlBookBySource(bookId);
  const scene = await ask("\n[1] 挂到 AL 已有书  [2] 新建上传（自动传书+笔记）  [q] 退出：");
  if (scene.toLowerCase() === "q") { rl.close(); return; }

  if (scene === "1") {
    // 场景一：需要 AL 目标书 id
    if (already) {
      console.log(`已找到 AL 中的对应书 id=${already.id}（来源标记一致）`);
    } else {
      const targetId = await ask("请输入 AL 中目标书的 id：");
      const r = await alApi("GET", `/api/books/${targetId}`);
      if (r.status !== 200) { console.log("目标书不存在"); rl.close(); return; }
      // 把微信书与 AL 书绑定（source_id 设为微信 bookId）
      await alApi("PATCH", `/api/books/${targetId}`, { source: "weread", source_id: bookId });
      console.log(`已绑定: AL 书 ${targetId} ← weread ${bookId}`);
      await syncNotesToAlBook(bookId, targetId, book.book?.title);
    }
  } else {
    // 场景二：自动找本地电子书 → 传书 + 同步
    const md = await findLocalBook(bookId, book.book?.title);
    if (!md) { console.log("未找到本地电子书，无法新建上传"); rl.close(); return; }
    const info = await weread("/book/info", { bookId });
    const up = await uploadBook(info.title || book.book?.title, md, bookId);
    if (up.status !== 201 && !up.data.exists) { console.log("上传书失败", JSON.stringify(up.data)); rl.close(); return; }
    console.log(`书已就绪: id=${up.data.id}${up.data.exists ? "（复用）" : ""}`);
    await syncNotesToAlBook(bookId, up.data.id, info.title || book.book?.title);
  }
  rl.close();
}

// 按 source_id 找 AL 中已绑定的书
async function findAlBookBySource(sourceId) {
  const r = await alApi("GET", `/api/books`);
  if (!Array.isArray(r.data)) return null;
  return r.data.find((b) => b.source === "weread" && b.source_id === sourceId) || null;
}

// 本地找书：匹配 ebooks 目录（epub/mobi/azw3），找不到返回 null
async function findLocalBook(bookId, title) {
  const candidates = fs.readdirSync(EBOOKS_DIR).filter((f) => /\.(epub|mobi|azw3)$/i.test(f));
  const strip = (s) => String(s).replace(/[\s[\]【】()（）·,，.:：=~"'“”]+/g, "");
  const key = strip(title || "").slice(0, 6);
  const guess = candidates.find((f) => strip(f).includes(key));
  if (!guess) return null;
  return convertToMd(EBOOKS_DIR + "/" + guess);
}

// 拉笔记 → 锚定 → 写入 AL 书（复用 cmdUpload 后半段逻辑）
async function syncNotesToAlBook(bookId, bookIdAl, title) {
  // 拉 AL 书正文做锚定基准
  const bookResp = await alApi("GET", `/api/books/${bookIdAl}`);
  const content = bookResp.data?.content || "";
  if (!content) { console.log("AL 书无正文，无法锚定"); return; }
  const paragraphs = content.split(/\r?\n/).filter((p) => p.trim().length > 0).map((p) => p.trim());

  const notes = await fetchNotes(bookId);
  // 锚定率（全量）
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))].filter((n) => n.markText && n.markText.length > 8);
  let hit = 0;
  for (const s of samples) if (anchorInParagraph(paragraphs, s.markText)) hit++;
  const total = samples.length;
  const rate = total ? Math.round((hit / total) * 100) : 0;
  console.log(`\n锚定测试: ${hit}/${total} (${rate}%) ${rate >= 85 ? "✅ 通过" : "⚠️ 低于 85%"}`);

  // 失败处理三选项
  if (rate < 85) {
    const choice = await ask("\n锚定低于 85%，如何处理？\n[1] 进待归位（默认，内容保留）  [2] 只传书不带笔记  [3] 放弃：");
    if (choice === "2") { console.log("只传书，跳过笔记同步"); return; }
    if (choice === "3") { console.log("已放弃"); return; }
  }

  // 同步笔记（锚定失败 → 待归位挂段落0）
  let hlOk = 0, ntOk = 0, fb = 0, skip = 0;
  for (const u of notes.underlines) {
    const a = anchorInParagraph(paragraphs, u.markText);
    if (!a) {
      const r = await alApi("POST", `/api/books/${bookIdAl}/notes`, { paragraph: 0, content: `[微信划线·待归位] ${u.markText.slice(0, 150)}`, agent: AL_AGENT, source_id: u.sourceId });
      if (r.status === 201) fb++;
      continue;
    }
    const r = await alApi("POST", `/api/books/${bookIdAl}/highlights`, { paragraph: a.paragraph, text: u.markText.slice(0, 200), agent: AL_AGENT, start_char: a.start_char, end_char: a.end_char, color: "yellow", source_id: u.sourceId });
    if (r.status === 201) hlOk++;
  }
  for (const rv of notes.reviews) {
    const a = rv.abstract ? anchorInParagraph(paragraphs, rv.abstract) : null;
    const body = { paragraph: a?.paragraph ?? 0, content: rv.content, agent: AL_AGENT, source_id: rv.sourceId };
    if (a) { body.start_char = a.start_char; body.end_char = a.end_char; }
    const r = await alApi("POST", `/api/books/${bookIdAl}/notes`, body);
    if (r.status === 201) ntOk++;
  }
  // 记录状态
  const state = readState();
  const maxT = Math.max(...notes.underlines.map((u) => u.createTime || 0), ...notes.reviews.map((r) => r.createTime || 0));
  if (maxT > 0) { state[bookId] = { lastSync: maxT, title }; writeState(state); }
  console.log(`\n同步完成: 划线 ${hlOk} / 想法 ${ntOk} / 待归位 ${fb}`);
}

// ---------- 入口 ----------
const cmd = process.argv[2];
try {
  if (!cmd) await cmdInteractive();
  else if (cmd === "list") await cmdList();
  else if (cmd === "validate" || cmd === "upload") {
    // 支持按 bookId 自动匹配 ebooks 目录里的本地 epub（避免命令行中文路径编码问题）
    const bookId = process.argv[3];
    let epubPath = process.argv[4];
    if (!epubPath) {
      // 从微信读书书名找 ebooks 目录下的书（epub/mobi/azw3，去标点模糊匹配）
      const info = await weread("/book/info", { bookId });
      const candidates = fs.readdirSync(EBOOKS_DIR).filter((f) => /\.(epub|mobi|azw3)$/i.test(f));
      const strip = (s) => String(s).replace(/[\s[\]【】()（）·,，.:：=~"'“”]+/g, "");
      const titleKey = strip(info.title || "").slice(0, 6);
      const guess = candidates.find((f) => strip(f).includes(titleKey));
      if (guess) epubPath = EBOOKS_DIR + "/" + guess;
      if (!epubPath) { console.error(`未找到 ${info.title} 的本地电子书，请手动指定路径`); process.exit(1); }
    }
    if (cmd === "validate") await cmdValidate(bookId, epubPath);
    else await cmdUpload(bookId, epubPath);
  }
  else { console.log("用法: node weread-sync.js <list|validate|upload> <bookId> [epub路径]"); process.exit(1); }
} catch (e) {
  console.error("错误:", e.message);
  process.exit(1);
}
