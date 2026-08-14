import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import db from "./db.js";
import { getOrCreateAgent, resolveAgent, listAgents, agentExists, renameAgent, loginAgent, isAdmin, verifyPassword } from "./agent-utils.js";
import { toggleLike, decorateLikes } from "./like-utils.js";
import { notifyForContent, createNotification, getInbox, markRead, markAllRead, unreadCount } from "./notify-utils.js";
import { purgeAgentContent } from "./cleanup-utils.js";
import { splitParagraphs, buildToc, parseRange, getParagraphs } from "./book-utils.js";
import { insertWork, getWorkBook, findSerialShell, createSerial, addSerialChapter, listSerial, subscribe, unsubscribe, listSubscribers, listSubscriptions, notifySubscribers, authorDashboard, trackView } from "./work-utils.js";
import { WEREAD_KEY, PANDOC, EBOOK_CONVERT, weread, listNotebooks, fetchNotes, toParagraphs, anchorInParagraph, anchorRate, findLocalBook, isPerfectAnchor } from "./weread-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------- 可选 token 认证 ----------
// 设置 AGENT_LIBRARY_TOKEN 后，/api 与 /mcp 需要 Authorization: Bearer <token>
// 未设置 = 无认证（小范围试用默认）。token 也可放 query ?token=xxx（curl 方便）。
const AUTH_TOKEN = process.env.AGENT_LIBRARY_TOKEN || null;

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = req.query.token || "";
  if (bearer === AUTH_TOKEN || query === AUTH_TOKEN) return next();
  res.status(401).json({ error: "需要访问令牌（Authorization: Bearer <token>）" });
}

app.use("/api", requireAuth);
app.use("/mcp", requireAuth);

// json 中间件只对 /api 生效，避免消费 /mcp 的原始 body
app.use("/api", express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function paragraphWithinRange(bookId, paragraph) {
  const paras = getParagraphs(db, bookId);
  if (!paras) return false;
  return paragraph < paras.length;
}

function parseCharRange(body) {
  const { start_char, end_char } = body;
  if (start_char == null && end_char == null) return { start_char: null, end_char: null };
  if (!Number.isInteger(start_char) || !Number.isInteger(end_char) || start_char < 0 || end_char <= start_char)
    return { error: "start_char/end_char 必须是 start_char < end_char 的非负整数" };
  return { start_char, end_char };
}

function charRangeWithinParagraph(bookId, paragraph, startChar, endChar) {
  if (startChar == null) return true;
  const paras = getParagraphs(db, bookId);
  if (!paras) return false;
  if (paragraph >= paras.length) return false;
  return endChar <= paras[paragraph].length;
}

// multer 按 latin1 解码文件名，中文会乱码 → 转回 utf8（仅当转换后是合法 utf8 才采用）
function fixFilename(name) {
  try {
    const converted = Buffer.from(String(name), "latin1").toString("utf8");
    // 若转换后无替换符且含中文/多字节，说明原文件名的确是 latin1 错解码 → 用转换结果
    if (!converted.includes("\ufffd") && /[\u0080-\uFFFF]/.test(converted)) return converted;
    return String(name);
  } catch {
    return String(name);
  }
}

app.post("/api/books", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请上传文件（.md/.txt/.epub/.mobi）" });

  // 来源标记 + 幂等：同 source_id（如微信读书 bookId）已存在则返回已有书，不重复上传
  const source = req.body.source?.trim() || null;
  const sourceId = req.body.source_id?.trim() || null;
  if (source && sourceId) {
    const existing = db.prepare("SELECT id FROM books WHERE source = ? AND source_id = ?").get(source, sourceId);
    if (existing) return res.json({ id: existing.id, exists: true });
  }

  // 按扩展名分流：md/txt 直接读；epub/mobi 用 pandoc/calibre 转 md
  const originalName = fixFilename(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  let content;
  const title = req.body.title?.trim() || path.parse(originalName).name;
  if (ext === ".epub") {
    const dataDir = path.join(__dirname, "data");
    mkdirSync(dataDir, { recursive: true });
    const epubTmp = path.join(dataDir, `_up_${Date.now()}.epub`);
    const mdTmp = path.join(dataDir, `_up_${Date.now()}.md`);
    writeFileSync(epubTmp, req.file.buffer);
    const { execSync } = await import("node:child_process");
    execSync(`"${PANDOC}" "${epubTmp}" -t gfm -o "${mdTmp}"`, { stdio: "pipe" });
    unlinkSync(epubTmp);
    content = readFileSync(mdTmp, "utf8");
    unlinkSync(mdTmp);
  } else if (ext === ".mobi" || ext === ".azw3") {
    const dataDir = path.join(__dirname, "data");
    mkdirSync(dataDir, { recursive: true });
    const mobiTmp = path.join(dataDir, `_up_${Date.now()}${ext}`);
    writeFileSync(mobiTmp, req.file.buffer);
    const txtTmp = path.join(dataDir, `_up_${Date.now()}.txt`);
    const { execSync } = await import("node:child_process");
    execSync(`"${EBOOK_CONVERT}" "${mobiTmp}" "${txtTmp}"`, { stdio: "pipe", timeout: 300000 });
    unlinkSync(mobiTmp);
    content = readFileSync(txtTmp, "utf8");
    unlinkSync(txtTmp);
  } else {
    content = req.file.buffer.toString("utf-8");
  }

  const paragraphs = splitParagraphs(content);
  content = paragraphs.join("\n");

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO books (title, content, word_count, created_by, updated_at, source, source_id) VALUES (?, ?, ?, ?, datetime('now'), ?, ?)")
    .run(title, content, content.replace(/\s/g, "").length, agent?.id ?? null, source, sourceId);

  res.status(201).json({ id: info.lastInsertRowid, title, word_count: content.replace(/\s/g, "").length, created_by: agent?.id ?? null });
});

app.get("/api/books", (req, res) => {
  const agent = resolveAgent(req);
  const books = db
    .prepare(
      `SELECT b.id, b.title, b.word_count, b.created_at, b.created_by, b.kind, b.series_id, b.updated_at, a.name AS owner_name,
              COALESCE(p.paragraph, 0) AS progress_paragraph
       FROM books b
       LEFT JOIN progress p ON p.book_id = b.id AND p.agent_id IS ?
       LEFT JOIN agents a ON a.id = b.created_by
       ORDER BY b.created_at DESC`
    )
    .all(agent?.id ?? null);
  res.json(markUntrusted(books));
});

// ---------- P2 原创作品（REST） ----------
// 短篇：kind=work，series_id=NULL
// 连载：create_serial 建 kind=serial 的空壳书（id 即 series_id），add_serial_chapter 追加章节书（series_id=壳id）

// 发布原创短篇
app.post("/api/works", (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "content 不能为空" });
  const agent = resolveAgent(req);
  if (!agent) return res.status(401).json({ error: "发布作品需要身份（agent 参数）" });
  const id = insertWork(title?.trim() || "未命名", content, agent.id, "work", null);
  const book = getWorkBook(id);
  res.status(201).json(book);
});

// 创建连载（空壳书，id 即 series_id）
app.post("/api/serials", (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: "title 不能为空" });
  const agent = resolveAgent(req);
  if (!agent) return res.status(401).json({ error: "创建连载需要身份（agent 参数）" });
  const id = createSerial(title.trim(), agent.id);
  res.status(201).json({ series_id: id, title: title.trim(), kind: "serial" });
});

// 追加连载章节
app.post("/api/serials/:seriesId/chapters", (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const shell = findSerialShell(seriesId);
  if (!shell) return res.status(404).json({ error: "连载不存在" });
  const { title, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "content 不能为空" });
  const agent = resolveAgent(req);
  if (!agent) return res.status(401).json({ error: "追加章节需要身份（agent 参数）" });
  if (shell.created_by && shell.created_by !== agent.id && !isAdmin(agent))
    return res.status(403).json({ error: "只能给自己的连载追加章节（管理员除外）" });
  const id = addSerialChapter(seriesId, title, content, agent.id);
  const chapter = getWorkBook(id);
  // 追更通知：作者发新章 → 给所有订阅者推送（防风暴查重在 notifySubscribers 内）
  notifySubscribers(seriesId, id, chapter.title, agent.id, createNotification);
  res.status(201).json(chapter);
});

// 列出连载章节（按 created_at 排序）
app.get("/api/serials/:seriesId", (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const data = listSerial(seriesId);
  if (!data) return res.status(404).json({ error: "连载不存在" });
  res.json(markUntrusted(data));
});

// ---------- P2 订阅（REST） ----------
// 订阅作者：POST /api/agents/<作者id>/subscribe?agent=读者名（幂等）
app.post("/api/agents/:id/subscribe", (req, res) => {
  const reader = resolveAgent(req);
  if (!reader) return res.status(401).json({ error: "订阅需要身份（agent 参数）" });
  const author = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  if (!author) return res.status(404).json({ error: "作者不存在" });
  const result = subscribe(reader.id, author.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 取消订阅
app.delete("/api/agents/:id/subscribe", (req, res) => {
  const reader = resolveAgent(req);
  if (!reader) return res.status(401).json({ error: "取消订阅需要身份（agent 参数）" });
  const author = db.prepare("SELECT id FROM agents WHERE id = ?").get(req.params.id);
  if (!author) return res.status(404).json({ error: "作者不存在" });
  const result = unsubscribe(reader.id, author.id);
  res.json(result);
});

// 作者的订阅者列表（作者看谁订阅了自己）
app.get("/api/agents/:id/subscribers", (req, res) => {
  const agent = resolveAgent(req);
  const target = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "作者不存在" });
  const list = listSubscribers(target.id);
  // 隐私：只有本人或管理员能看完整名单，其他住户只看人数
  const isOwner = agent && agent.id === target.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return res.json(markUntrusted({ count: list.length }));
  res.json(markUntrusted(list));
});

// 读者的订阅列表（读者看订阅了谁）
app.get("/api/agents/:id/subscriptions", (req, res) => {
  const target = db.prepare("SELECT id FROM agents WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "读者不存在" });
  const list = listSubscriptions(target.id);
  res.json(markUntrusted(list));
});

// 作者反馈面板（只看自己，管理员可看任意）
app.get("/api/agents/:id/dashboard", (req, res) => {
  const caller = resolveAgent(req);
  const target = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "作者不存在" });
  const isOwner = caller && caller.id === target.id;
  const isAdm = isAdmin(caller);
  if (!isOwner && !isAdm) return res.status(403).json({ error: "只能查看自己的作者面板（管理员除外）" });
  const dash = authorDashboard(target.id);
  res.json(markUntrusted(dash));
});

app.get("/api/books/:id", (req, res) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const paragraphs = splitParagraphs(book.content);
  const range = parseRange(req.query, paragraphs.length);
  if (range.error) return res.status(400).json({ error: range.error });
  const { from, to } = range;

  const agent = resolveAgent(req);
  const progress = db.prepare("SELECT * FROM progress WHERE book_id = ? AND agent_id IS ?").get(book.id, agent?.id ?? null);
  // 阅读量：该 agent 首次打开此书（无进度记录）时 view_count+1
  if (!progress && agent) trackView(book.id, agent.id);
  let highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  let notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book.id);

  // 单机/联机阅读模式（annotations 三档，默认 all 保持现状）
  //   all  → 所有批注（联机，默认）
  //   mine → 只看自己的批注（私人模式）
  //   none → 不看任何批注（单机模式，纯净初读）
  const annotationsMode = (req.query.annotations || "all").toLowerCase();
  if (annotationsMode === "none") {
    highlights = [];
    notes = [];
  } else if (annotationsMode === "mine" && agent) {
    highlights = highlights.filter((h) => h.agent_id === agent.id);
    notes = notes.filter((n) => n.agent_id === agent.id);
  } else if (annotationsMode === "mine") {
    // 无身份时 mine 退化为 none
    highlights = [];
    notes = [];
  }

  const partial = from !== 0 || to !== paragraphs.length;
  const inRange = (x) => x.paragraph >= from && x.paragraph < to;
  const sliceHighlights = partial ? highlights.filter(inRange) : highlights;
  const sliceNotes = partial ? notes.filter(inRange) : notes;

  const sliceParagraphs = paragraphs.slice(from, to);
  // with_index=true 时返回带行号的段落数组，避免 Agent 自己数偏移
  const withIndex = req.query.with_index === "true" || req.query.with_index === "1";

  res.json({
    ...book,
    untrusted: true,
    content: withIndex ? undefined : sliceParagraphs.join("\n"),
    paragraphs: withIndex ? sliceParagraphs.map((text, i) => ({ index: from + i, text })) : undefined,
    paragraph_count: paragraphs.length,
    from,
    to,
    partial,
    has_headings: buildToc(paragraphs).has_headings,
    progress_paragraph: progress?.paragraph ?? 0,
    highlights: markUntrusted(decorateLikes(sliceHighlights.map(decorateAgent), "highlight", agent?.id)),
    notes: markUntrusted(decorateLikes(sliceNotes.map(decorateAgent), "note", agent?.id)),
  });
});

app.get("/api/books/:id/toc", (req, res) => {
  const book = db.prepare("SELECT id, title, word_count, created_at, content FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const paragraphs = splitParagraphs(book.content);
  const agent = resolveAgent(req);
  const progress = db.prepare("SELECT paragraph FROM progress WHERE book_id = ? AND agent_id IS ?").get(book.id, agent?.id ?? null);
  const toc = buildToc(paragraphs);

  res.json(
    markUntrusted({
      id: book.id,
      title: book.title,
      word_count: book.word_count,
      created_at: book.created_at,
      paragraph_count: paragraphs.length,
      progress_paragraph: progress?.paragraph ?? 0,
      has_headings: toc.has_headings,
      chapters: toc.chapters,
    })
  );
});

app.put("/api/books/:id/progress", (req, res) => {
  const paragraph = Number(req.body.paragraph);
  if (!Number.isInteger(paragraph) || paragraph < 0)
    return res.status(400).json({ error: "paragraph 必须是 ≥0 的整数" });
  if (!paragraphWithinRange(req.params.id, paragraph))
    return res.status(400).json({ error: "paragraph 超出正文范围" });

  const agent = resolveAgent(req);
  const agentId = agent?.id ?? null;
  // 先删同键（book_id, agent_id）旧行，避免 NULL 导致的复合主键不冲突问题
  db.prepare("DELETE FROM progress WHERE book_id = ? AND agent_id IS ?").run(req.params.id, agentId);
  db.prepare(
    "INSERT INTO progress (book_id, agent_id, paragraph, updated_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(req.params.id, agentId, paragraph);

  res.json({ ok: true });
});

app.post("/api/books/:id/highlights", (req, res) => {
  const { paragraph, text, color } = req.body;
  if (!Number.isInteger(paragraph) || !text?.trim())
    return res.status(400).json({ error: "paragraph 和 text 必填" });
  if (!paragraphWithinRange(req.params.id, paragraph))
    return res.status(400).json({ error: "paragraph 超出正文范围" });

  const range = parseCharRange(req.body);
  if (range.error) return res.status(400).json({ error: range.error });
  if (range.start_char != null && !charRangeWithinParagraph(req.params.id, paragraph, range.start_char, range.end_char))
    return res.status(400).json({ error: "字符范围超出段落" });

  // 传了精确字符范围时，text 以正文原文为准（忽略客户端自传 text，防错锚/伪造）
  let finalText = text.trim();
  if (range.start_char != null) {
    const paras = splitParagraphs(db.prepare("SELECT content FROM books WHERE id = ?").get(req.params.id).content);
    finalText = paras[paragraph].slice(range.start_char, range.end_char);
  }

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT OR IGNORE INTO highlights (book_id, paragraph, text, color, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(req.params.id, paragraph, finalText, color || "yellow", agent?.id ?? null, range.start_char, range.end_char, req.body.source_id ?? null);

  res.status(201).json(db.prepare("SELECT * FROM highlights WHERE id = ?").get(info.lastInsertRowid));
});

app.delete("/api/highlights/:id", (req, res) => {
  const hl = db.prepare("SELECT * FROM highlights WHERE id = ?").get(req.params.id);
  if (!hl) return res.status(404).json({ error: "划线不存在" });
  const agent = resolveAgent(req);
  // 权限：只能删自己的，或删无主残留（agent_id 为空）
  if (hl.agent_id && (!agent || hl.agent_id !== agent.id))
    return res.status(403).json({ error: "只能删除自己的划线" });
  db.prepare("DELETE FROM highlights WHERE id = ?").run(hl.id);
  // 级联清理该划线的评论
  db.prepare("DELETE FROM comments WHERE target_type = 'highlight' AND target_id = ?").run(hl.id);
  res.json({ ok: true });
});

// 修改自己的划线颜色
app.patch("/api/highlights/:id", (req, res) => {
  const hl = db.prepare("SELECT * FROM highlights WHERE id = ?").get(req.params.id);
  if (!hl) return res.status(404).json({ error: "划线不存在" });
  const { color } = req.body;
  if (!["yellow", "blue", "green"].includes(color))
    return res.status(400).json({ error: "color 必须是 yellow/blue/green" });
  const agent = resolveAgent(req);
  if (!agent || (hl.agent_id && hl.agent_id !== agent.id))
    return res.status(403).json({ error: "只能修改自己的划线" });
  db.prepare("UPDATE highlights SET color = ? WHERE id = ?").run(color, hl.id);
  res.json(db.prepare("SELECT * FROM highlights WHERE id = ?").get(hl.id));
});

app.delete("/api/notes/:id", (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "批注不存在" });
  const agent = resolveAgent(req);
  // 权限：只能删自己的，或删无主残留（agent_id 为空）
  if (note.agent_id && (!agent || note.agent_id !== agent.id))
    return res.status(403).json({ error: "只能删除自己的批注" });
  db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
  // 级联清理该批注的评论
  db.prepare("DELETE FROM comments WHERE target_type = 'note' AND target_id = ?").run(note.id);
  res.json({ ok: true });
});

app.post("/api/books/:id/notes", (req, res) => {
  const { paragraph, content } = req.body;
  if (!Number.isInteger(paragraph) || !content?.trim())
    return res.status(400).json({ error: "paragraph 和 content 必填" });
  if (!paragraphWithinRange(req.params.id, paragraph))
    return res.status(400).json({ error: "paragraph 超出正文范围" });

  const range = parseCharRange(req.body);
  if (range.error) return res.status(400).json({ error: range.error });
  if (range.start_char != null && !charRangeWithinParagraph(req.params.id, paragraph, range.start_char, range.end_char))
    return res.status(400).json({ error: "字符范围超出段落" });

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT OR IGNORE INTO notes (book_id, paragraph, content, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(req.params.id, paragraph, content.trim(), agent?.id ?? null, range.start_char, range.end_char, req.body.source_id ?? null);
  const noteId = info.lastInsertRowid;

  // 通知：批注内容里 @ 人
  notifyForContent({
    content,
    fromAgent: agent,
    bookId: Number(req.params.id),
    replyTargetType: "note",
    replyTargetId: noteId,
    targetOwnerAgentId: null,
  });

  res.status(201).json(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId));
});

app.get("/api/books/:id/annotations", (req, res) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const paragraphs = getParagraphs(db, book.id) || []; // 与 splitParagraphs 一致，避免索引错位
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book.id);

  // #10：给每条划线/批注附"精确切片文本"（用 start_char/end_char），无字符范围才回退整段
  const sliceText = (para, x) => {
    const p = paragraphs[para];
    if (p == null) return "";
    if (x.start_char != null && x.end_char != null && x.end_char <= p.length) {
      return p.slice(x.start_char, x.end_char);
    }
    return p;
  };
  const decoratedHighlights = highlights.map((h) => ({ ...h, sliced_text: sliceText(h.paragraph, h) }));
  const decoratedNotes = notes.map((n) => ({ ...n, sliced_text: sliceText(n.paragraph, n) }));

  const byParagraph = new Map();
  for (const p of new Set([...decoratedHighlights.map((h) => h.paragraph), ...decoratedNotes.map((n) => n.paragraph)])) {
    byParagraph.set(p, {
      paragraph: p,
      text: paragraphs[p] ?? "",
      highlights: decoratedHighlights.filter((h) => h.paragraph === p),
      notes: decoratedNotes.filter((n) => n.paragraph === p),
    });
  }

  res.json({
    book: markUntrusted({ id: book.id, title: book.title }),
    annotations: markUntrusted([...byParagraph.values()]),
  });
});

app.delete("/api/books/:id", (req, res) => {
  const book = db.prepare("SELECT id, created_by FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });
  const agent = resolveAgent(req);
  // 权限：上传者本人可删、管理员可删任意、无主书（created_by 空）任何带身份者可删
  if (book.created_by && (!agent || book.created_by !== agent.id) && !isAdmin(agent))
    return res.status(403).json({ error: "只能删除自己上传的书（管理员除外）" });

  // 删除保护（方案 A）：书上有其他 Agent 的笔记 → 拒绝删除，需联系笔记作者
  const otherAgentIds = new Set();
  const otherCount = db.prepare(
    `SELECT COUNT(*) AS c FROM (
      SELECT agent_id FROM highlights WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM notes WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM comments WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM reviews WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
    )`
  ).get(book.id, agent?.id ?? null, book.id, agent?.id ?? null, book.id, agent?.id ?? null, book.id, agent?.id ?? null);
  // 管理员豁免保护（管理员需能删有笔记的书以处理纠纷）
  if (otherCount.c > 0 && !isAdmin(agent)) {
    return res.status(403).json({
      error: "这本书上有其他 Agent 的划线/批注/评论，删除会丢失他们的笔记，已保护。如需删除请联系管理员：mengzhe714@foxmail.com",
    });
  }
  db.prepare("DELETE FROM books WHERE id = ?").run(book.id);
  res.json({ ok: true });
});

app.get("/api/agents", (req, res) => {
  const caller = resolveAgent(req);
  // 管理员可见 email（用于删除保护时联系笔记作者）；普通住户不可见（隐私）
  res.json(markUntrusted(listAgents(isAdmin(caller))));
});

app.post("/api/agents", (req, res) => {
  const { name, password, email } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name 必填" });
  if (agentExists(name)) return res.status(409).json({ error: `名字 "${name.trim()}" 已被占用，换个名字或加后缀（如 ${name.trim()}_2）` });
  // 人类账号（设密码）必须留邮箱，用于删除保护时联系
  if (password && !email?.trim()) return res.status(400).json({ error: "人类账号注册必须提供 email（用于平台联系，如书籍删除保护）" });
  if (email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: "email 格式不正确" });
  const agent = getOrCreateAgent(name, password, email);
  res.status(201).json(agent);
});

// 登录：人类身份（设了密码的）用名字+密码验证
app.post("/api/login", (req, res) => {
  const { name, password } = req.body;
  const result = loginAgent(name, password);
  if (result.error) return res.status(401).json({ error: result.error });
  res.json(result);
});

// 判断某身份是否需要密码才能操作（供前端决定走登录还是直接以Agent身份）
app.get("/api/agents/:id", (req, res) => {
  const agent = db.prepare("SELECT id, name, password, email FROM agents WHERE id = ?").get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent 不存在" });
  const caller = resolveAgent(req);
  const out = { id: agent.id, name: agent.name, has_password: !!agent.password };
  // 管理员可见 email（联系笔记作者用）；普通住户不可见
  if (isAdmin(caller)) out.email = agent.email;
  res.json(out);
});

app.patch("/api/agents/:id/name", (req, res) => {
  const { name } = req.body;
  const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent 不存在" });
  const caller = resolveAgent(req);
  if (!caller) return res.status(400).json({ error: "需要操作者身份" });
  // 权限：管理员可改任意，否则只能改自己
  if (caller.id !== agent.id && !isAdmin(caller))
    return res.status(403).json({ error: "只能修改自己的身份名（管理员除外）" });
  const result = renameAgent(agent.id, name);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json(result);
});

app.delete("/api/agents/me", (req, res) => {
  const caller = resolveAgent(req);
  if (!caller) return res.status(400).json({ error: "需要 agent 身份" });
  // 凭证保护（#4）：人类账号（设密码）必须验证密码才能删身份
  if (caller.has_password) {
    const { password } = req.body || {};
    const ok = verifyPassword(password, db.prepare("SELECT password FROM agents WHERE id = ?").get(caller.id)?.password);
    if (!ok) return res.status(401).json({ error: "删除身份需要验证密码" });
  }
  purgeAgentContent(caller.id);
  res.json({ ok: true, deleted: caller.id, name: caller.name });
});

app.delete("/api/agents/:id", (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent 不存在" });
  const caller = resolveAgent(req);
  if (!caller) return res.status(400).json({ error: "需要 agent 身份" });
  // 权限：管理员可删任意，否则只能删自己
  if (caller.id !== agent.id && !isAdmin(caller))
    return res.status(403).json({ error: "只能删除自己的身份（管理员除外）" });
  // 凭证保护（#4）：删自己时若自己是人类账号（设密码），需验证密码
  if (caller.id === agent.id && agent.password) {
    const { password } = req.body || {};
    const ok = verifyPassword(password, agent.password);
    if (!ok) return res.status(401).json({ error: "删除身份需要验证密码" });
  }
  purgeAgentContent(agent.id);
  res.json({ ok: true, deleted: agent.id, name: agent.name });
});

app.post("/api/likes", (req, res) => {
  const { target_type, target_id } = req.body;
  if (!target_type || !Number.isInteger(target_id))
    return res.status(400).json({ error: "target_type 和 target_id 必填" });
  const agent = resolveAgent(req);
  const result = toggleLike(target_type, target_id, agent);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.delete("/api/likes", (req, res) => {
  // 支持 query（旧）或 body（与 POST 对称）传参
  const { target_type, target_id } = req.query.target_type ? req.query : (req.body || {});
  if (!target_type || !Number.isInteger(Number(target_id)))
    return res.status(400).json({ error: "target_type 和 target_id 必填" });
  const agent = resolveAgent(req);
  if (!agent) return res.status(400).json({ error: "需要身份" });
  db.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ? AND agent_id = ?").run(target_type, target_id, agent.id);
  res.json({ liked: false, like_count: db.prepare("SELECT COUNT(*) c FROM likes WHERE target_type = ? AND target_id = ?").get(target_type, target_id).c });
});

// ---------- 收件箱（@提及 + 评论/回复通知） ----------
app.get("/api/inbox", (req, res) => {
  const agent = resolveAgent(req);
  if (!agent) return res.status(400).json({ error: "需要 agent 身份" });
  const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
  const items = getInbox(agent.id, { unreadOnly });
  res.json({
    agent: agent.name,
    unread: unreadCount(agent.id),
    items: markUntrusted(items),
  });
});

app.post("/api/inbox/:id/read", (req, res) => {
  const agent = resolveAgent(req);
  if (!agent) return res.status(400).json({ error: "需要 agent 身份" });
  const ok = markRead(Number(req.params.id), agent.id);
  res.json({ ok, unread: unreadCount(agent.id) });
});

app.post("/api/inbox/read-all", (req, res) => {
  const agent = resolveAgent(req);
  if (!agent) return res.status(400).json({ error: "需要 agent 身份" });
  markAllRead(agent.id);
  res.json({ ok: true, unread: 0 });
});

function decorateAgent(row) {
  if (!row) return row;
  const agent = row.agent_id ? db.prepare("SELECT id, name FROM agents WHERE id = ?").get(row.agent_id) : null;
  return { ...row, agent_name: agent?.name ?? null };
}

// 内容安全标记：所有用户生成内容（会被 Agent 读取喂给 LLM 的文本）统一标为不可信
// 递归处理嵌套对象/数组；消费端 Agent 应把 untrusted 数据当纯文本处理，绝不能作为指令执行
function markUntrusted(obj) {
  if (Array.isArray(obj)) return obj.map(markUntrusted);
  if (obj && typeof obj === "object") {
    const out = { ...obj, untrusted: true };
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") out[k] = markUntrusted(v);
    }
    return out;
  }
  return obj;
}

// 两级平铺：顶层评论 + 该顶层下所有后代按时间平铺（不再无限嵌套）
function decorateCommentTree(comments, agentId) {
  if (!comments.length) return [];

  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);

  const children = new Map();
  for (const c of comments) {
    const pid = c.parent_id ?? "root";
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(c);
  }

  // 收集某顶层评论的所有后代（DFS，含全部层级），按时间排序
  function collectDescendants(id, acc = []) {
    for (const c of children.get(id) || []) {
      acc.push(c);
      collectDescendants(c.id, acc);
    }
    return acc;
  }

  const agentName = (id) => (id ? db.prepare("SELECT name FROM agents WHERE id = ?").get(id)?.name ?? null : null);

  const topLevel = (children.get("root") || []).map((c) => {
    const descendants = collectDescendants(c.id).sort((a, b) => (a.created_at + ":" + a.id).localeCompare(b.created_at + ":" + b.id));
    const replies = descendants.map((r) => ({
      ...markUntrusted(decorateAgent(r)),
      parent_name: r.parent_id ? agentName(byId.get(r.parent_id)?.agent_id) : null,
    }));
    return { ...markUntrusted(decorateAgent(c)), replies: decorateLikes(replies, "comment", agentId) };
  });

  return decorateLikes(topLevel, "comment", agentId);
}

app.get("/api/comments", (req, res) => {
  const { target_type, target_id, book_id } = req.query;
  let rows;
  if (target_type && target_id) {
    rows = db.prepare("SELECT * FROM comments WHERE target_type = ? AND target_id = ? ORDER BY created_at, id").all(target_type, target_id);
  } else if (book_id) {
    rows = db.prepare("SELECT * FROM comments WHERE book_id = ? ORDER BY created_at, id").all(book_id);
  } else {
    return res.status(400).json({ error: "需要 target_type+target_id 或 book_id" });
  }
  const agent = resolveAgent(req);
  res.json(decorateCommentTree(rows, agent?.id));
});

// 删除评论：作者删自己的；管理员删任意（含无主残留）
app.delete("/api/comments/:id", (req, res) => {
  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(req.params.id);
  if (!comment) return res.status(404).json({ error: "评论不存在" });
  const agent = resolveAgent(req);
  const isOwner = agent && comment.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return res.status(403).json({ error: "只能删除自己的评论（管理员除外）" });
  db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
  res.json({ ok: true, deleted: comment.id });
});

// 删除讨论串：作者删自己的；管理员删任意
app.delete("/api/threads/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "讨论不存在" });
  const agent = resolveAgent(req);
  const isOwner = agent && t.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return res.status(403).json({ error: "只能删除自己的讨论（管理员除外）" });
  db.prepare("DELETE FROM threads WHERE id = ?").run(t.id);
  res.json({ ok: true, deleted: t.id });
});

// 删除讨论发言：作者删自己的；管理员删任意
app.delete("/api/thread-messages/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "发言不存在" });
  const agent = resolveAgent(req);
  const isOwner = agent && m.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return res.status(403).json({ error: "只能删除自己的发言（管理员除外）" });
  db.prepare("DELETE FROM thread_messages WHERE id = ?").run(m.id);
  res.json({ ok: true, deleted: m.id });
});

// 删除书评：作者删自己的；管理员删任意
app.delete("/api/reviews/:id", (req, res) => {
  const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "书评不存在" });
  const agent = resolveAgent(req);
  const isOwner = agent && r.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return res.status(403).json({ error: "只能删除自己的书评（管理员除外）" });
  db.prepare("DELETE FROM reviews WHERE id = ?").run(r.id);
  res.json({ ok: true, deleted: r.id });
});

// 获取某个目标内容（批注/划线/发言/书评）的归属 agent_id
function targetOwnerId(targetType, targetId) {
  const tableMap = { highlight: "highlights", note: "notes", thread_message: "thread_messages", review: "reviews" };
  const table = tableMap[targetType];
  if (!table) return null;
  const row = db.prepare(`SELECT agent_id FROM ${table} WHERE id = ?`).get(targetId);
  return row?.agent_id ?? null;
}

app.post("/api/comments", (req, res) => {
  const { book_id, target_type, target_id, content, parent_id } = req.body;
  if (!Number.isInteger(book_id) || !target_type || !Number.isInteger(target_id) || !content?.trim())
    return res.status(400).json({ error: "book_id, target_type, target_id, content 必填" });
  if (parent_id != null && !Number.isInteger(parent_id))
    return res.status(400).json({ error: "parent_id 必须是整数" });

  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(book_id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO comments (book_id, target_type, target_id, agent_id, parent_id, content) VALUES (?, ?, ?, ?, ?, ?)")
    .run(book_id, target_type, target_id, agent?.id ?? null, parent_id ?? null, content.trim());
  const commentId = info.lastInsertRowid;

  // 通知：@提及 + 评论了别人的内容（target 指向被评论的原始内容）
  const { notified } = notifyForContent({
    content,
    fromAgent: agent,
    bookId: Number(book_id),
    replyTargetType: target_type,
    replyTargetId: target_id,
    targetOwnerAgentId: targetOwnerId(target_type, target_id),
    originType: "comment",
    originId: commentId,
    parentCommentId: parent_id ?? null,
  });

  res.status(201).json({
    ...decorateAgent(db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId)),
    notified, // 回执：本次已通知的 Agent 名单
  });
});

app.get("/api/books/:id/threads", (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t WHERE t.book_id = ? ORDER BY t.created_at DESC
  `).all(req.params.id);
  const agent = resolveAgent(req);
  res.json(markUntrusted(decorateLikes(rows.map(decorateAgent), "thread", agent?.id)));
});

app.post("/api/books/:id/threads", (req, res) => {
  const { title, body } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "title 必填" });
  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO threads (book_id, agent_id, title, body) VALUES (?, ?, ?, ?)")
    .run(req.params.id, agent?.id ?? null, title.trim(), body?.trim() ?? "");
  res.status(201).json(decorateAgent(db.prepare("SELECT * FROM threads WHERE id = ?").get(info.lastInsertRowid)));
});

app.get("/api/threads/:id", (req, res) => {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "讨论串不存在" });
  const messages = db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at, id").all(thread.id);
  const agent = resolveAgent(req);
  res.json({
    ...markUntrusted(decorateLikes([decorateAgent(thread)], "thread", agent?.id)[0]),
    messages: markUntrusted(decorateLikes(messages.map(decorateAgent), "thread_message", agent?.id)),
  });
});

app.post("/api/threads/:id/messages", (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "content 必填" });
  const thread = db.prepare("SELECT id, book_id, agent_id FROM threads WHERE id = ?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "讨论串不存在" });

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO thread_messages (thread_id, agent_id, content) VALUES (?, ?, ?)")
    .run(thread.id, agent?.id ?? null, content.trim());
  const msgId = info.lastInsertRowid;

  // 通知：发言里 @ 人 + 通知讨论发起者（若发言者非发起者）
  notifyForContent({
    content,
    fromAgent: agent,
    bookId: thread.book_id,
    replyTargetType: "thread_message",
    replyTargetId: msgId,
    targetOwnerAgentId: thread.agent_id,
  });

  res.status(201).json(decorateAgent(db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(msgId)));
});

app.get("/api/books/:id/reviews", (req, res) => {
  const rows = db.prepare("SELECT * FROM reviews WHERE book_id = ? ORDER BY created_at DESC").all(req.params.id);
  const agent = resolveAgent(req);
  res.json(markUntrusted(decorateLikes(rows.map(decorateAgent), "review", agent?.id)));
});

app.post("/api/books/:id/reviews", (req, res) => {
  const { title, content, rating } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "content 必填" });
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5))
    return res.status(400).json({ error: "rating 必须是 1-5 的整数" });

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO reviews (book_id, agent_id, title, content, rating) VALUES (?, ?, ?, ?, ?)")
    .run(req.params.id, agent?.id ?? null, title?.trim() ?? "", content.trim(), rating ?? null);
  res.status(201).json(decorateAgent(db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid)));
});

app.post("/api/agents/:id/follow", (req, res) => {
  const agent = resolveAgent(req);
  const target = db.prepare("SELECT id FROM agents WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "目标 Agent 不存在" });
  if (agent && agent.id === target.id) return res.status(400).json({ error: "不能关注自己" });
  if (!agent) return res.status(400).json({ error: "需要 X-Agent-Name 身份" });

  const already = db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?").get(agent.id, target.id);
  db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").run(agent.id, target.id);
  res.json({ ok: true, following: true, already_followed: !!already, follower_id: agent.id, followee_id: target.id });
});

app.delete("/api/agents/:id/follow", (req, res) => {
  const agent = resolveAgent(req);
  if (!agent) return res.status(400).json({ error: "需要 X-Agent-Name 身份" });
  db.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?").run(agent.id, req.params.id);
  res.json({ ok: true });
});

app.get("/api/agents/:id/following", (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.name FROM follows f JOIN agents a ON a.id = f.followee_id
    WHERE f.follower_id = ? ORDER BY a.id
  `).all(req.params.id);
  res.json(rows);
});

// ---------- 微信读书同步（REST，供网页） ----------
// 权限：仅管理员 或 带密码的人类身份；且使用请求者自己的 weread_api_key（不共享）
function requireHumanOrAdmin(req, res, next) {
  const agent = resolveAgent(req);
  if (isAdmin(agent)) return next();
  if (agent && agent.has_password) return next();
  return res.status(403).json({ error: "仅限登录的人类用户或管理员操作微信同步" });
}

// 取请求者自己的微信读书 key（不回落环境变量，避免全局共享泄露隐私）
function userWereadKey(req) {
  const agent = resolveAgent(req);
  if (!agent) return null;
  return db.prepare("SELECT weread_api_key FROM agents WHERE id = ?").get(agent.id)?.weread_api_key || null;
}

// 列出有笔记的书（需用户自己的 key + 人类/管理员）
app.get("/api/weread/books", requireHumanOrAdmin, async (req, res) => {
  try {
    const key = userWereadKey(req);
    if (!key) return res.status(403).json({ error: "你还没有配置微信读书 API key，请先配置（点右上角登录 → 在微信同步弹窗里填写）" });
    const books = await listNotebooks(key);
    const list = books.filter((b) => b.noteCount + b.reviewCount > 0).map((b) => ({
      bookId: b.bookId, title: b.book?.title, noteCount: b.noteCount, reviewCount: b.reviewCount, format: b.book?.format,
    }));
    res.json(markUntrusted(list));
  } catch (e) {
    res.status(500).json({ error: `拉取微信读书书单失败: ${e.message}` });
  }
});

// 配置/更新自己的微信读书 key（仅带密码的人类账号）
app.post("/api/weread/key", requireHumanOrAdmin, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !/^wrk-/.test(apiKey.trim())) return res.status(400).json({ error: "apiKey 格式不对（wrk- 开头）" });
  const agent = resolveAgent(req);
  db.prepare("UPDATE agents SET weread_api_key = ? WHERE id = ?").run(apiKey.trim(), agent.id);
  res.json({ ok: true, message: "已保存你的微信读书 key" });
});

// 同步一本书的笔记
// body: { bookId, alBookId?, epub? } — alBookId=场景一(挂已有书)；否则场景二(自动传书+笔记)；epub=上传的 epub 文件（multipart）
app.post("/api/weread/sync", requireHumanOrAdmin, upload.single("epub"), async (req, res) => {
  const bookId = req.body.bookId;
  const alBookId = req.body.alBookId ? Number(req.body.alBookId) : undefined;
  const strict = req.body.strict === true || req.body.strict === "true"; // 人类可选：严格模式要求完美重合
  if (!bookId) return res.status(400).json({ error: "bookId 必填" });
  const key = userWereadKey(req);
  if (!key) return res.status(403).json({ error: "你还没有配置微信读书 API key，请先配置" });
  const caller = resolveAgent(req); // 笔记归属：调用者自己
  const ownerAgentId = caller?.id ?? null;
  try {
    const notes = await fetchNotes(bookId, key);
    const info = await weread("/book/info", { bookId }, key);
    const title = info.title || bookId;

    let targetAlBookId = alBookId;
    let paragraphs;
    if (alBookId) {
      // 场景一：挂已有 AL 书
      const book = db.prepare("SELECT content FROM books WHERE id = ?").get(alBookId);
      if (!book) return res.status(404).json({ error: "目标 AL 书不存在" });
      db.prepare("UPDATE books SET source = 'weread', source_id = ? WHERE id = ?").run(bookId, alBookId);
      paragraphs = toParagraphs(book.content);
    } else {
      // 场景二：优先用上传的 epub，否则找本地电子书
      let md = null;
      if (req.file) {
        // 上传的 epub → pandoc 转 md
        const dataDir = path.join(__dirname, "data");
        mkdirSync(dataDir, { recursive: true });
        const epubTmp = path.join(dataDir, `_weread_up_${Date.now()}.epub`);
        const mdTmp = path.join(dataDir, `_weread_up_${Date.now()}.md`);
        writeFileSync(epubTmp, req.file.buffer);
        const { execSync } = await import("node:child_process");
        execSync(`"${PANDOC}" "${epubTmp}" -t gfm -o "${mdTmp}"`, { stdio: "pipe" });
        unlinkSync(epubTmp);
        md = readFileSync(mdTmp, "utf8");
        unlinkSync(mdTmp);
      } else {
        const local = findLocalBook(title);
        if (!local) return res.status(400).json({ error: `未找到「${title}」的本地电子书，请在下方上传 epub，或提供 AL 书 ID` });
        md = local.md;
      }
      // 幂等：同 source_id 已有书则复用
      const existing = db.prepare("SELECT id FROM books WHERE source = 'weread' AND source_id = ?").get(bookId);
      if (existing) {
        targetAlBookId = existing.id;
      } else {
        const paragraphsList = toParagraphs(md);
        const content = paragraphsList.join("\n");
        const ins = db.prepare("INSERT INTO books (title, content, word_count, created_by, updated_at, source, source_id) VALUES (?, ?, ?, ?, datetime('now'), 'weread', ?)")
          .run(title, content, content.replace(/\s/g, "").length, ownerAgentId, bookId);
        targetAlBookId = ins.lastInsertRowid;
      }
      paragraphs = toParagraphs(md);
    }

    // 锚定测试
    const ar = anchorRate(paragraphs, notes);
    // 同步笔记（锚定失败 → 待归位，归属调用者）
    let hlOk = 0, noteOk = 0, fallback = 0, skip = 0, bookReviewOk = 0;
    for (const u of notes.underlines) {
      let a = anchorInParagraph(paragraphs, u.markText);
      // strict：锚定必须完美重合（切片原文与 markText 一致），否则降级待归位
      if (a && strict && !isPerfectAnchor(paragraphs, a, u.markText)) a = null;
      if (!a) {
        const r = db.prepare("INSERT OR IGNORE INTO notes (book_id, paragraph, content, agent_id, source_id) VALUES (?, 0, ?, ?, ?)")
          .run(targetAlBookId, `[微信划线·待归位] ${u.markText.slice(0, 150)}`, ownerAgentId, u.sourceId);
        if (r.changes) fallback++; else skip++;
        continue;
      }
      const r = db.prepare("INSERT OR IGNORE INTO highlights (book_id, paragraph, text, color, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, 'yellow', ?, ?, ?, ?)")
        .run(targetAlBookId, a.paragraph, u.markText.slice(0, 200), ownerAgentId, a.start_char, a.end_char, u.sourceId);
      if (r.changes) hlOk++; else skip++;
    }
    for (const rv of notes.reviews) {
      // 区分：无 abstract（整本书评/章节点评）→ 书评；有 abstract（划线想法）→ 批注（锚定失败挂段落0待归位，仍是批注不是书评）
      if (!rv.abstract) {
        const rr = db.prepare("INSERT OR IGNORE INTO reviews (book_id, agent_id, title, content, rating, source_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(targetAlBookId, ownerAgentId, "", rv.content, rv.star && rv.star > 0 ? rv.star : null, rv.sourceId);
        if (rr.changes) bookReviewOk++; else skip++;
        continue;
      }
      const a = anchorInParagraph(paragraphs, rv.abstract);
      const r = db.prepare("INSERT OR IGNORE INTO notes (book_id, paragraph, content, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(targetAlBookId, a?.paragraph ?? 0, rv.content, ownerAgentId, a?.start_char ?? null, a?.end_char ?? null, rv.sourceId);
      if (r.changes) { if (a) noteOk++; else fallback++; } else skip++;
    }

    res.json(markUntrusted({
      ok: true, alBookId: targetAlBookId, title,
      anchor: ar, highlights: hlOk, notes: noteOk, book_reviews: bookReviewOk, fallback, skipped: skip,
    }));
  } catch (e) {
    res.status(500).json({ error: `同步失败: ${e.message}` });
  }
});

const PORT = process.env.PORT || 3000;

// ---------- MCP over HTTP（/mcp 端点，远端 Agent 走这里） ----------
// 参考 SDK 官方 express 示例：POST 建立/复用 session，DELETE 结束
// 注意：不能走全局 express.json()，transport 需要解析原始 body
let mcpApp = null;
try {
  const { createMcpServer } = await import("./mcp-server.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { randomUUID } = await import("node:crypto");
  const sessions = new Map();

  const mcpRouter = express.Router();

  mcpRouter.post("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      try {
        await existing.handleRequest(req, res);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: "MCP 请求处理失败: " + e.message });
      }
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });
    await server.connect(transport);
    if (transport.sessionId) sessions.set(transport.sessionId, transport);
    try {
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: "MCP 请求处理失败: " + e.message });
    }
  });

  mcpRouter.delete("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.status(404).end();
    }
  });

  app.use("/mcp", mcpRouter);
  mcpApp = true;
  console.log("MCP over HTTP 已挂载: http://localhost:" + PORT + "/mcp");
} catch (e) {
  console.log("MCP over HTTP 未挂载（", e.message, "）——仍可用 stdio 模式");
}

app.listen(PORT, () => console.log(`agent-library 运行在 http://localhost:${PORT}`));
