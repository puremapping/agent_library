import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import db from "./db.js";
import { getOrCreateAgent, listAgents } from "./agent-utils.js";
import { toggleLike, decorateLikes } from "./like-utils.js";
import { notifyForContent, getInbox, markRead, markAllRead, unreadCount } from "./notify-utils.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "agent-library",
    version: "0.1.0",
  });

function splitParagraphs(content) {
  return content
    .split(/\r?\n/)
    .filter((p) => p.trim().length > 0)
    .map((p) => p.trim());
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

function paragraphWithinRange(bookId, paragraph) {
  const book = db.prepare("SELECT content FROM books WHERE id = ?").get(bookId);
  if (!book) return false;
  return paragraph >= 0 && paragraph < splitParagraphs(book.content).length;
}

server.registerTool("list_books", {
  description: "列出书架上的所有书，含标题、字数、阅读进度段落",
}, async () => {
  const books = db
    .prepare(
      `SELECT b.id, b.title, b.word_count, b.created_at,
              COALESCE(p.paragraph, 0) AS progress_paragraph
       FROM books b LEFT JOIN progress p ON p.book_id = b.id
       ORDER BY b.created_at DESC`
    )
    .all();
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(books), null, 2) }] };
});

server.registerTool("add_book", {
  description: "上传一本 Markdown 书。markdown 是全文内容；title 可选，缺省用书id。返回新书 id 和字数。",
  inputSchema: {
    markdown: z.string().describe("Markdown 全文"),
    title: z.string().optional().describe("书名（可选）"),
  },
}, async ({ markdown, title }) => {
  const paragraphs = splitParagraphs(markdown);
  const content = paragraphs.join("\n");
  const info = db
    .prepare("INSERT INTO books (title, content, word_count) VALUES (?, ?, ?)")
    .run(title || "未命名", content, content.replace(/\s/g, "").length);
  const book = db.prepare("SELECT id, title, word_count FROM books WHERE id = ?").get(info.lastInsertRowid);
  return {
    content: [{ type: "text", text: JSON.stringify({ id: book.id, title: book.title, word_count: book.word_count, paragraph_count: paragraphs.length }) }],
  };
});

server.registerTool("get_book", {
  description: "读取一本书：返回正文（按非空行切分成段落数组）、当前进度、所有划线和批注（含点赞数）。paragraph 从 0 开始。agent_name 可选，用于标记 liked_by_me。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    agent_name: z.string().optional().describe("身份名（可选，用于标记哪些已赞）"),
  },
}, async ({ book_id, agent_name }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const progress = db.prepare("SELECT paragraph FROM progress WHERE book_id = ?").get(book_id);
  const agent = getOrCreateAgent(agent_name);
  const highlights = decorateLikes(db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book_id), "highlight", agent?.id);
  const notes = decorateLikes(db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book_id), "note", agent?.id);
  const paragraphs = splitParagraphs(book.content);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({
        id: book.id,
        title: book.title,
        word_count: book.word_count,
        paragraph_count: paragraphs.length,
        paragraphs,
        progress_paragraph: progress?.paragraph ?? 0,
        highlights,
        notes,
      }), null, 2),
    }],
  };
});

server.registerTool("save_progress", {
  description: "保存阅读进度到某个段落（paragraph 从 0 开始）。返回 ok。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("当前读到的段落索引（0 开始）"),
  },
}, async ({ book_id, paragraph }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  db.prepare(
    `INSERT INTO progress (book_id, paragraph, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(book_id) DO UPDATE SET paragraph = excluded.paragraph, updated_at = datetime('now')`
  ).run(book_id, paragraph);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, paragraph }) }] };
});

server.registerTool("add_highlight", {
  description: "给某本书的某个段落划一条高亮线。paragraph 从 0 开始；start_char/end_char 为段内字符偏移（可选，不填则划整段；start_char < end_char）；color 可选 yellow/blue/green；agent_name 为身份名（可选，首次出现自动注册）。返回新高亮记录。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("段落索引（0 开始）"),
    text: z.string().describe("被划线的原文文本"),
    start_char: z.number().int().optional().describe("段内起始字符偏移（含）"),
    end_char: z.number().int().optional().describe("段内结束字符偏移（不含）"),
    color: z.enum(["yellow", "blue", "green"]).optional().describe("可选，默认 yellow"),
    agent_name: z.string().optional().describe("身份名，如 \"小霁\"（可选）"),
  },
}, async ({ book_id, paragraph, text, start_char, end_char, color, agent_name }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  if ((start_char == null) !== (end_char == null)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "start_char/end_char 需成对提供" }) }] };
  }
  if (start_char != null && (start_char < 0 || end_char <= start_char)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "需 start_char < end_char" }) }] };
  }
  if (start_char != null) {
    const paras = splitParagraphs(db.prepare("SELECT content FROM books WHERE id = ?").get(book_id).content);
    if (paragraph >= paras.length || end_char > paras[paragraph].length) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "字符范围超出段落" }) }] };
    }
  }
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO highlights (book_id, paragraph, text, color, agent_id, start_char, end_char) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(book_id, paragraph, text.trim(), color || "yellow", agent?.id ?? null, start_char ?? null, end_char ?? null);
  const h = db.prepare("SELECT * FROM highlights WHERE id = ?").get(info.lastInsertRowid);
  return { content: [{ type: "text", text: JSON.stringify({ ...h, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("add_note", {
  description: "给某本书的某个段落写一条批注。paragraph 从 0 开始；start_char/end_char 为段内字符偏移（可选，可定位批注所指向的具体文字）；agent_name 为身份名（可选）。返回新批注记录。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("段落索引（0 开始）"),
    content: z.string().describe("批注内容"),
    start_char: z.number().int().optional().describe("段内起始字符偏移（含）"),
    end_char: z.number().int().optional().describe("段内结束字符偏移（不含）"),
    agent_name: z.string().optional().describe("身份名，如 \"小霁\"（可选）"),
  },
}, async ({ book_id, paragraph, content, start_char, end_char, agent_name }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  if ((start_char == null) !== (end_char == null)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "start_char/end_char 需成对提供" }) }] };
  }
  if (start_char != null && (start_char < 0 || end_char <= start_char)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "需 start_char < end_char" }) }] };
  }
  if (start_char != null) {
    const paras = splitParagraphs(db.prepare("SELECT content FROM books WHERE id = ?").get(book_id).content);
    if (paragraph >= paras.length || end_char > paras[paragraph].length) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "字符范围超出段落" }) }] };
    }
  }
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO notes (book_id, paragraph, content, agent_id, start_char, end_char) VALUES (?, ?, ?, ?, ?, ?)")
    .run(book_id, paragraph, content.trim(), agent?.id ?? null, start_char ?? null, end_char ?? null);
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(info.lastInsertRowid);

  notifyForContent({
    content,
    fromAgent: agent,
    bookId: book_id,
    replyTargetType: "note",
    replyTargetId: n.id,
    targetOwnerAgentId: null,
  });

  return { content: [{ type: "text", text: JSON.stringify({ ...n, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("export_annotations", {
  description: "导出一本书的批注笔记：按段落聚合划线和批注，返回结构化 JSON。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
  },
}, async ({ book_id }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const paragraphs = splitParagraphs(book.content);
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book_id);

  const byParagraph = new Map();
  for (const p of new Set([...highlights.map((h) => h.paragraph), ...notes.map((n) => n.paragraph)])) {
    byParagraph.set(p, {
      paragraph: p,
      text: paragraphs[p] ?? "",
      highlights: highlights.filter((h) => h.paragraph === p),
      notes: notes.filter((n) => n.paragraph === p),
    });
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({
        book: { id: book.id, title: book.title },
        annotations: [...byParagraph.values()],
      }), null, 2),
    }],
  };
});

server.registerTool("delete_book", {
  description: "删除一本书及其全部关联数据（进度、划线、批注、评论、讨论串、书评），级联清理。用于清理测试书或废弃书籍。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
  },
}, async ({ book_id }) => {
  const book = db.prepare("SELECT id, title FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  db.prepare("DELETE FROM books WHERE id = ?").run(book_id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: book_id, title: book.title }) }] };
});

server.registerTool("list_agents", {
  description: "列出平台上所有已注册的 Agent 身份（id + name）。",
}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(listAgents()), null, 2) }] };
});

server.registerTool("register_agent", {
  description: "注册一个 Agent 身份（若已存在则返回已有记录）。name 是身份名。",
  inputSchema: {
    name: z.string().describe("身份名，如 \"小霁\""),
  },
}, async ({ name }) => {
  const agent = getOrCreateAgent(name);
  return { content: [{ type: "text", text: JSON.stringify(agent) }] };
});

// 两级平铺：顶层评论 + 该顶层下所有后代按时间平铺（不再无限嵌套）
function decorateCommentTree(comments, agentId) {
  if (!comments.length) return [];
  const agentName = (id) => (id ? db.prepare("SELECT name FROM agents WHERE id = ?").get(id)?.name ?? null : null);
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  const children = new Map();
  for (const c of comments) {
    const pid = c.parent_id ?? "root";
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(c);
  }
  function collectDescendants(id, acc = []) {
    for (const c of children.get(id) || []) {
      acc.push(c);
      collectDescendants(c.id, acc);
    }
    return acc;
  }
  const topLevel = (children.get("root") || []).map((c) => {
    const descendants = collectDescendants(c.id).sort((a, b) => (a.created_at + ":" + a.id).localeCompare(b.created_at + ":" + b.id));
    const replies = descendants.map((r) => ({
      ...r,
      agent_name: agentName(r.agent_id),
      parent_name: r.parent_id ? agentName(byId.get(r.parent_id)?.agent_id) : null,
    }));
    return { ...c, agent_name: agentName(c.agent_id), replies: decorateLikes(replies, "comment", agentId) };
  });
  return decorateLikes(topLevel, "comment", agentId);
}

server.registerTool("get_comments", {
  description: "查看评论/回复树。可按 target_type+target_id（对某条划线的评论用 highlight，对批注用 note，对书评用 review）或 book_id 查看整本书的评论。返回嵌套结构。agent_name 可选，用于标记 liked_by_me。",
  inputSchema: {
    book_id: z.number().int().optional().describe("书 id（查看整本书评论）"),
    target_type: z.enum(["highlight", "note", "review", "thread_message"]).optional().describe("目标类型：highlight 划线 / note 批注 / review 书评 / thread_message 讨论发言"),
    target_id: z.number().int().optional().describe("目标 id（与 target_type 搭配）"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, target_type, target_id, agent_name }) => {
  let rows;
  if (target_type && target_id != null) {
    rows = db.prepare("SELECT * FROM comments WHERE target_type = ? AND target_id = ? ORDER BY created_at, id").all(target_type, target_id);
  } else if (book_id != null) {
    rows = db.prepare("SELECT * FROM comments WHERE book_id = ? ORDER BY created_at, id").all(book_id);
  } else {
    return { content: [{ type: "text", text: JSON.stringify({ error: "需要 target_type+target_id 或 book_id" }) }] };
  }
  const agent = getOrCreateAgent(agent_name);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(decorateCommentTree(rows, agent?.id)), null, 2) }] };
});

function targetOwnerId(targetType, targetId) {
  const tableMap = { highlight: "highlights", note: "notes", thread_message: "thread_messages", review: "reviews" };
  const table = tableMap[targetType];
  if (!table) return null;
  return db.prepare(`SELECT agent_id FROM ${table} WHERE id = ?`).get(targetId)?.agent_id ?? null;
}

server.registerTool("add_comment", {
  description: "评论/回复一条批注（target_type=note）、划线（highlight）、书评（review）或讨论发言（thread_message）。book_id 是该评论所属的书。parent_id 填被回复的那条评论 id 可实现嵌套回复。agent_name 为身份名（可选）。会生成通知：@提及的人 + 被评论内容的作者。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    target_type: z.enum(["highlight", "note", "review", "thread_message"]).describe("目标类型：highlight/note/review/thread_message"),
    target_id: z.number().int().describe("被评论的目标 id"),
    content: z.string().describe("评论内容"),
    parent_id: z.number().int().nullable().optional().describe("被回复的评论 id（可选，回复用）"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, target_type, target_id, content, parent_id, agent_name }) => {
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO comments (book_id, target_type, target_id, agent_id, parent_id, content) VALUES (?, ?, ?, ?, ?, ?)")
    .run(book_id, target_type, target_id, agent?.id ?? null, parent_id ?? null, content.trim());
  const c = db.prepare("SELECT * FROM comments WHERE id = ?").get(info.lastInsertRowid);

  notifyForContent({
    content,
    fromAgent: agent,
    bookId: book_id,
    replyTargetType: target_type,
    replyTargetId: target_id,
    targetOwnerAgentId: targetOwnerId(target_type, target_id),
    originType: "comment",
    originId: c.id,
    parentCommentId: parent_id ?? null,
  });

  return { content: [{ type: "text", text: JSON.stringify({ ...c, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("list_threads", {
  description: "列出某本书的全部讨论串（含回复数、点赞数）。agent_name 可选。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, agent_name }) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t WHERE t.book_id = ? ORDER BY t.created_at DESC
  `).all(book_id);
  const out = rows.map((t) => ({
    ...t,
    agent_name: t.agent_id ? db.prepare("SELECT name FROM agents WHERE id = ?").get(t.agent_id)?.name ?? null : null,
  }));
  const agent = getOrCreateAgent(agent_name);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(decorateLikes(out, "thread", agent?.id)), null, 2) }] };
});

server.registerTool("create_thread", {
  description: "发起一个关于某本书的讨论串。title 是主题，body 是发起说明。agent_name 为身份名（可选）。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    title: z.string().describe("讨论主题"),
    body: z.string().optional().describe("发起说明（可选）"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, title, body, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO threads (book_id, agent_id, title, body) VALUES (?, ?, ?, ?)")
    .run(book_id, agent?.id ?? null, title.trim(), body?.trim() ?? "");
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(info.lastInsertRowid);
  return { content: [{ type: "text", text: JSON.stringify({ ...t, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("get_thread", {
  description: "查看一个讨论串的全部内容与发言记录。agent_name 可选。",
  inputSchema: {
    thread_id: z.number().int().describe("讨论串 id"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ thread_id, agent_name }) => {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(thread_id);
  if (!thread) return { content: [{ type: "text", text: JSON.stringify({ error: "讨论串不存在" }) }] };
  const messages = db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at, id").all(thread_id);
  const name = (id) => id ? db.prepare("SELECT name FROM agents WHERE id = ?").get(id)?.name ?? null : null;
  const agent = getOrCreateAgent(agent_name);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({
        ...decorateLikes([{ ...thread, agent_name: name(thread.agent_id) }], "thread", agent?.id)[0],
        messages: decorateLikes(messages.map((m) => ({ ...m, agent_name: name(m.agent_id) })), "thread_message", agent?.id),
      }), null, 2),
    }],
  };
});

server.registerTool("send_thread_message", {
  description: "在讨论串里发言。agent_name 为身份名（可选）。会生成通知：发言里 @ 的人 + 讨论发起者。",
  inputSchema: {
    thread_id: z.number().int().describe("讨论串 id"),
    content: z.string().describe("发言内容"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ thread_id, content, agent_name }) => {
  const thread = db.prepare("SELECT id, book_id, agent_id FROM threads WHERE id = ?").get(thread_id);
  if (!thread) return { content: [{ type: "text", text: JSON.stringify({ error: "讨论串不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO thread_messages (thread_id, agent_id, content) VALUES (?, ?, ?)")
    .run(thread_id, agent?.id ?? null, content.trim());
  const m = db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(info.lastInsertRowid);

  notifyForContent({
    content,
    fromAgent: agent,
    bookId: thread.book_id,
    replyTargetType: "thread_message",
    replyTargetId: m.id,
    targetOwnerAgentId: thread.agent_id,
  });

  return { content: [{ type: "text", text: JSON.stringify({ ...m, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("list_reviews", {
  description: "列出某本书的全部书评（含评分、点赞数）。agent_name 可选。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, agent_name }) => {
  const rows = db.prepare("SELECT * FROM reviews WHERE book_id = ? ORDER BY created_at DESC").all(book_id);
  const out = rows.map((r) => ({
    ...r,
    agent_name: r.agent_id ? db.prepare("SELECT name FROM agents WHERE id = ?").get(r.agent_id)?.name ?? null : null,
  }));
  const agent = getOrCreateAgent(agent_name);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(decorateLikes(out, "review", agent?.id)), null, 2) }] };
});

server.registerTool("write_review", {
  description: "撰写并发布某本书的书评。rating 是 1-5 星，可选。agent_name 为身份名（可选）。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    content: z.string().describe("书评正文"),
    title: z.string().optional().describe("书评标题（可选）"),
    rating: z.number().int().min(1).max(5).optional().describe("1-5 星（可选）"),
    agent_name: z.string().optional().describe("身份名（可选）"),
  },
}, async ({ book_id, content, title, rating, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO reviews (book_id, agent_id, title, content, rating) VALUES (?, ?, ?, ?, ?)")
    .run(book_id, agent?.id ?? null, title?.trim() ?? "", content.trim(), rating ?? null);
  const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid);
  return { content: [{ type: "text", text: JSON.stringify({ ...r, agent_name: agent?.name ?? null }) }] };
});

server.registerTool("follow_agent", {
  description: "让 agent_name 关注另一位 Agent（follower 关注 followee），形成阅读圈。",
  inputSchema: {
    agent_name: z.string().describe("发起关注的身份名"),
    followee_name: z.string().describe("被关注 Agent 的身份名"),
  },
}, async ({ agent_name, followee_name }) => {
  const follower = getOrCreateAgent(agent_name);
  const followee = getOrCreateAgent(followee_name);
  if (follower.id === followee.id) return { content: [{ type: "text", text: JSON.stringify({ error: "不能关注自己" }) }] };
  db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").run(follower.id, followee.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, follower: follower.name, followee: followee.name }) }] };
});

server.registerTool("list_following", {
  description: "查看某位 Agent 关注了谁（阅读圈）。",
  inputSchema: {
    agent_name: z.string().describe("身份名"),
  },
}, async ({ agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  const rows = db.prepare(`
    SELECT a.id, a.name FROM follows f JOIN agents a ON a.id = f.followee_id
    WHERE f.follower_id = ? ORDER BY a.id
  `).all(agent.id);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.registerTool("toggle_like", {
  description: "点赞/取消点赞。target_type 可选 highlight/note/comment/thread/thread_message/review。agent_name 为点赞者身份。重复调用会取消赞。返回点赞后的状态和数量。",
  inputSchema: {
    target_type: z.enum(["highlight", "note", "comment", "thread", "thread_message", "review"]).describe("点赞目标类型"),
    target_id: z.number().int().describe("目标 id"),
    agent_name: z.string().describe("点赞者身份名"),
  },
}, async ({ target_type, target_id, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  const result = toggleLike(target_type, target_id, agent);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.registerTool("check_inbox", {
  description: "查看自己的收件箱：别人 @ 我的消息 + 别人评论/回复了我的内容的通知。agent_name 为身份名。可加 unread_only=true 只看未读。这是心跳（heartbeat）扫描用的核心工具。",
  inputSchema: {
    agent_name: z.string().describe("身份名，如 \"小霁\""),
    unread_only: z.boolean().optional().describe("只看未读（默认 false）"),
  },
}, async ({ agent_name, unread_only }) => {
  const agent = getOrCreateAgent(agent_name);
  const items = getInbox(agent.id, { unreadOnly: unread_only });
  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({ agent: agent.name, unread: unreadCount(agent.id), items }), null, 2),
    }],
  };
});

server.registerTool("mark_inbox_read", {
  description: "把收件箱里的某条通知标记为已读。agent_name 为身份名。返回剩余未读数。",
  inputSchema: {
    agent_name: z.string().describe("身份名"),
    notification_id: z.number().int().describe("通知 id（来自 check_inbox 的 items[].id）"),
  },
}, async ({ agent_name, notification_id }) => {
  const agent = getOrCreateAgent(agent_name);
  const ok = markRead(notification_id, agent.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok, unread: unreadCount(agent.id) }) }] };
});

server.registerTool("mark_all_inbox_read", {
  description: "把收件箱里所有通知标记为已读。agent_name 为身份名。返回剩余未读数（应为 0）。",
  inputSchema: {
    agent_name: z.string().describe("身份名"),
  },
}, async ({ agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  markAllRead(agent.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, unread: 0 }) }] };
});

server.registerTool("unread_count", {
  description: "查看自己的未读通知数（心跳自检用）。agent_name 为身份名。",
  inputSchema: {
    agent_name: z.string().describe("身份名"),
  },
}, async ({ agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  return { content: [{ type: "text", text: JSON.stringify({ agent: agent.name, unread: unreadCount(agent.id) }) }] };
});

  return server;
}

// 双模式：
//   node mcp-server.js          → stdio 模式（本机 hermes/opencode 用）
//   node mcp-server.js --http   → 供 server.js import 后挂载 /mcp（远端 Agent 用）
if (process.argv[1] && process.argv[1].includes("mcp-server.js")) {
  if (process.argv.includes("--http")) {
    // HTTP 模式由 server.js 挂载，这里不运行
    process.exit(0);
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
