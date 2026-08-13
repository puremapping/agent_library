import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import { getOrCreateAgent, resolveAgent, listAgents } from "./agent-utils.js";
import { toggleLike, decorateLikes } from "./like-utils.js";
import { notifyForContent, getInbox, markRead, markAllRead, unreadCount } from "./notify-utils.js";

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

function splitParagraphs(content) {
  return content
    .split(/\r?\n/)
    .filter((p) => p.trim().length > 0)
    .map((p) => p.trim());
}

function paragraphWithinRange(bookId, paragraph) {
  const book = db.prepare("SELECT content FROM books WHERE id = ?").get(bookId);
  if (!book) return false;
  return paragraph < splitParagraphs(book.content).length;
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
  const book = db.prepare("SELECT content FROM books WHERE id = ?").get(bookId);
  const paras = splitParagraphs(book.content);
  if (paragraph >= paras.length) return false;
  return endChar <= paras[paragraph].length;
}

app.post("/api/books", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请上传 .md 文件" });

  let content = req.file.buffer.toString("utf-8");
  const title = req.body.title?.trim() || path.parse(req.file.originalname).name;

  const paragraphs = splitParagraphs(content);
  content = paragraphs.join("\n");

  const info = db
    .prepare("INSERT INTO books (title, content, word_count) VALUES (?, ?, ?)")
    .run(title, content, content.replace(/\s/g, "").length);

  res.status(201).json({ id: info.lastInsertRowid, title, word_count: content.replace(/\s/g, "").length });
});

app.get("/api/books", (req, res) => {
  const books = db
    .prepare(
      `SELECT b.id, b.title, b.word_count, b.created_at,
              COALESCE(p.paragraph, 0) AS progress_paragraph
       FROM books b
       LEFT JOIN progress p ON p.book_id = b.id
       ORDER BY b.created_at DESC`
    )
    .all();
  res.json(markUntrusted(books));
});

app.get("/api/books/:id", (req, res) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const progress = db.prepare("SELECT * FROM progress WHERE book_id = ?").get(book.id);
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  const agent = resolveAgent(req);

  res.json({
    ...book,
    untrusted: true,
    progress_paragraph: progress?.paragraph ?? 0,
    highlights: markUntrusted(decorateLikes(highlights.map(decorateAgent), "highlight", agent?.id)),
    notes: markUntrusted(decorateLikes(notes.map(decorateAgent), "note", agent?.id)),
  });
});

app.put("/api/books/:id/progress", (req, res) => {
  const paragraph = Number(req.body.paragraph);
  if (!Number.isInteger(paragraph) || paragraph < 0)
    return res.status(400).json({ error: "paragraph 必须是 ≥0 的整数" });
  if (!paragraphWithinRange(req.params.id, paragraph))
    return res.status(400).json({ error: "paragraph 超出正文范围" });

  db.prepare(
    `INSERT INTO progress (book_id, paragraph, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(book_id) DO UPDATE SET paragraph = excluded.paragraph, updated_at = datetime('now')`
  ).run(req.params.id, paragraph);

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

  const agent = resolveAgent(req);
  const info = db
    .prepare("INSERT INTO highlights (book_id, paragraph, text, color, agent_id, start_char, end_char) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(req.params.id, paragraph, text.trim(), color || "yellow", agent?.id ?? null, range.start_char, range.end_char);

  res.status(201).json(db.prepare("SELECT * FROM highlights WHERE id = ?").get(info.lastInsertRowid));
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
    .prepare("INSERT INTO notes (book_id, paragraph, content, agent_id, start_char, end_char) VALUES (?, ?, ?, ?, ?, ?)")
    .run(req.params.id, paragraph, content.trim(), agent?.id ?? null, range.start_char, range.end_char);
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

  const paragraphs = book.content.split("\n");
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book.id);

  const byParagraph = new Map();
  for (const p of new Set([...highlights.map((h) => h.paragraph), ...notes.map((n) => n.paragraph)])) {
    byParagraph.set(p, {
      paragraph: p,
      text: paragraphs[p] ?? "",
      highlights: highlights.filter((h) => h.paragraph === p),
      notes: notes.filter((n) => n.paragraph === p),
    });
  }

  res.json({
    book: markUntrusted({ id: book.id, title: book.title }),
    annotations: markUntrusted([...byParagraph.values()]),
  });
});

app.delete("/api/books/:id", (req, res) => {
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });
  db.prepare("DELETE FROM books WHERE id = ?").run(book.id);
  res.json({ ok: true });
});

app.get("/api/agents", (req, res) => {
  res.json(markUntrusted(listAgents()));
});

app.post("/api/agents", (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name 必填" });
  const agent = getOrCreateAgent(name);
  res.status(201).json(agent);
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
  const { target_type, target_id } = req.query;
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
  notifyForContent({
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

  res.status(201).json(decorateAgent(db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId)));
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

  db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").run(agent.id, target.id);
  res.json({ ok: true });
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
