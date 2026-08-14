// weread-sync.js — 微信读书 → Agent-Library 同步脚本（人机共读桥）
// 用法：
//   node weread-sync.js                          # 交互式引导
//   node weread-sync.js list                      # 列出有笔记的书
//   node weread-sync.js validate <bookId> <epub路径>  # 锚定测试
//   node weread-sync.js upload <bookId> <epub路径>    # 上传书+笔记到 AL
// 环境变量：WEREAD_API_KEY, AL_BASE, AL_AGENT, PANDOC_PATH, EBOOK_CONVERT_PATH, EBOOKS_DIR
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  WEREAD_KEY, AL_BASE, AL_AGENT, EBOOKS_DIR,
  weread, listNotebooks, fetchNotes, convertToMd, toParagraphs,
  anchorInParagraph, anchorRate, findLocalBook,
  readState, writeState, lastSyncOf,
} from "./weread-lib.js";

if (!WEREAD_KEY) { console.error("需要 WEREAD_API_KEY 环境变量（wrk- 开头）"); process.exit(1); }

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
  const paragraphs = toParagraphs(md);
  const { hit, total, rate } = anchorRate(paragraphs, notes);
  console.log(`锚定测试：${hit}/${total} 命中（${rate}%），${total === 0 ? "无笔记样本" : rate >= 85 ? "✅ 同版，可上传" : "❌ 版本不一致，拒绝"}`);
  return rate >= 85;
}

async function cmdUpload(bookId, epubPath) {
  const notes = await fetchNotes(bookId);
  const md = convertToMd(epubPath);
  const paragraphs = toParagraphs(md);
  const { hit, total, rate } = anchorRate(paragraphs, notes);
  if (rate < 85) { console.error(`锚定率 ${rate}% < 85%，拒绝上传（版本可能不一致）`); process.exit(1); }
  console.log(`锚定 ${hit}/${total}（${rate}%）通过，开始上传`);

  const info = await weread("/book/info", { bookId });
  const title = info.title || path.basename(epubPath);
  const up = await uploadBook(title, md, bookId);
  if (up.status !== 201 && !up.data.exists) { console.error("上传书失败:", JSON.stringify(up.data)); process.exit(1); }
  const bookIdAl = up.data.id;
  console.log(`书已上传: id=${bookIdAl} title=${title}${up.data.exists ? "（已存在，复用）" : ""}`);

  await syncNotesToAlBook(bookId, bookIdAl, title, paragraphs, notes);
}

// 同步笔记到 AL 书（锚定失败 → 待归位挂段落0）；供 upload 与交互模式共用
async function syncNotesToAlBook(bookId, bookIdAl, title, paragraphs, notes) {
  const state = readState();
  const lastSync = lastSyncOf(state, bookId);
  let newUnderlines = notes.underlines;
  let newReviews = notes.reviews;
  if (lastSync > 0) {
    newUnderlines = notes.underlines.filter((u) => (u.createTime || 0) > lastSync);
    newReviews = notes.reviews.filter((r) => (r.createTime || 0) > lastSync);
    console.log(`增量同步（上次 ${new Date(lastSync * 1000).toISOString().slice(0, 10)}）：新划线 ${newUnderlines.length} / 新想法 ${newReviews.length}`);
  }

  let hlOk = 0, hlSkip = 0, noteOk = 0, noteSkip = 0, hlFallback = 0, noteFallback = 0;
  for (const u of newUnderlines) {
    const a = anchorInParagraph(paragraphs, u.markText);
    if (!a) {
      const fb = await alApi("POST", `/api/books/${bookIdAl}/notes`, {
        paragraph: 0, content: `[微信划线·待归位] ${u.markText.slice(0, 150)}`, agent: AL_AGENT, source_id: u.sourceId,
      });
      if (fb.status === 201) hlFallback++; else hlSkip++;
      continue;
    }
    const r = await alApi("POST", `/api/books/${bookIdAl}/highlights`, {
      paragraph: a.paragraph, text: u.markText.slice(0, 200), agent: AL_AGENT,
      start_char: a.start_char, end_char: a.end_char, color: "yellow", source_id: u.sourceId,
    });
    if (r.status === 201) hlOk++; else hlSkip++;
  }
  for (const rv of newReviews) {
    const a = rv.abstract ? anchorInParagraph(paragraphs, rv.abstract) : null;
    const body = { paragraph: a?.paragraph ?? 0, content: rv.content, agent: AL_AGENT, source_id: rv.sourceId };
    if (a) { body.start_char = a.start_char; body.end_char = a.end_char; } else { noteFallback++; }
    const r = await alApi("POST", `/api/books/${bookIdAl}/notes`, body);
    if (r.status === 201) noteOk++; else noteSkip++;
  }
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
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function cmdInteractive() {
  console.log("=== 微信读书 → Agent-Library 同步（交互式）===\n");
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

  const already = await findAlBookBySource(bookId);
  const scene = await ask("\n[1] 挂到 AL 已有书  [2] 新建上传（自动传书+笔记）  [q] 退出：");
  if (scene.toLowerCase() === "q") { rl.close(); return; }

  if (scene === "1") {
    let targetId = already?.id;
    if (!targetId) {
      const input = await ask("请输入 AL 中目标书的 id：");
      targetId = parseInt(input, 10);
      if (!targetId) { console.log("无效 id"); rl.close(); return; }
    }
    const r = await alApi("GET", `/api/books/${targetId}`);
    if (r.status !== 200) { console.log("目标书不存在"); rl.close(); return; }
    if (!already) {
      await alApi("PATCH", `/api/books/${targetId}`, { source: "weread", source_id: bookId });
      console.log(`已绑定: AL 书 ${targetId} ← weread ${bookId}`);
    } else {
      console.log(`已找到 AL 中的对应书 id=${targetId}（来源标记一致）`);
    }
    const content = r.data?.content || "";
    const paragraphs = toParagraphs(content);
    const notes = await fetchNotes(bookId);
    const { hit, total, rate } = anchorRate(paragraphs, notes);
    console.log(`\n锚定测试: ${hit}/${total} (${rate}%) ${rate >= 85 ? "✅ 通过" : "⚠️ 低于 85%"}`);
    if (rate < 85) {
      const choice = await ask("\n锚定低于 85%，如何处理？\n[1] 进待归位（默认，内容保留）  [2] 只挂书不带笔记  [3] 放弃：");
      if (choice === "2") { console.log("只挂书，跳过笔记同步"); rl.close(); return; }
      if (choice === "3") { console.log("已放弃"); rl.close(); return; }
    }
    await syncNotesToAlBook(bookId, targetId, book.book?.title, paragraphs, notes);
  } else {
    const local = findLocalBook(book.book?.title);
    if (!local) { console.log("未找到本地电子书，无法新建上传"); rl.close(); return; }
    const info = await weread("/book/info", { bookId });
    const up = await uploadBook(info.title || book.book?.title, local.md, bookId);
    if (up.status !== 201 && !up.data.exists) { console.log("上传书失败", JSON.stringify(up.data)); rl.close(); return; }
    console.log(`书已就绪: id=${up.data.id}${up.data.exists ? "（复用）" : ""}`);
    const paragraphs = toParagraphs(local.md);
    const notes = await fetchNotes(bookId);
    await syncNotesToAlBook(bookId, up.data.id, info.title || book.book?.title, paragraphs, notes);
  }
  rl.close();
}

async function findAlBookBySource(sourceId) {
  const r = await alApi("GET", `/api/books`);
  if (!Array.isArray(r.data)) return null;
  return r.data.find((b) => b.source === "weread" && b.source_id === sourceId) || null;
}

// ---------- 入口 ----------
const cmd = process.argv[2];
try {
  if (!cmd) await cmdInteractive();
  else if (cmd === "list") await cmdList();
  else if (cmd === "validate" || cmd === "upload") {
    const bookId = process.argv[3];
    let epubPath = process.argv[4];
    if (!epubPath) {
      const info = await weread("/book/info", { bookId });
      const candidates = fs.readdirSync(EBOOKS_DIR).filter((f) => /\.(epub|mobi|azw3)$/i.test(f));
      const strip = (s) => String(s).replace(/[\s[\]【】()（）·,，.:：=~"'“”]+/g, "");
      const titleKey = strip(info.title || "").slice(0, 6);
      const guess = candidates.find((f) => strip(f).includes(titleKey));
      if (guess) epubPath = EBOOKS_DIR + "/" + guess;
      if (!epubPath) {
        // 递归子目录兜底（如"补充样例/同版"）
        const local = findLocalBook(info.title);
        if (local) epubPath = local.path;
      }
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
