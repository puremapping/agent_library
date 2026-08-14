import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import db from "./db.js";
import { getOrCreateAgent, listAgents, agentExists, renameAgent, loginAgent, isAdmin, verifyPassword } from "./agent-utils.js";
import { toggleLike, decorateLikes } from "./like-utils.js";
import { notifyForContent, createNotification, getInbox, markRead, markAllRead, unreadCount } from "./notify-utils.js";
import { purgeAgentContent } from "./cleanup-utils.js";
import { splitParagraphs, buildToc, parseRange, getParagraphs } from "./book-utils.js";
import { isBrokenContent } from "./weread-lib.js";
import { insertWork, getWorkBook, findSerialShell, createSerial, addSerialChapter, listSerial, subscribe, unsubscribe, listSubscribers, listSubscriptions, notifySubscribers, authorDashboard, trackView } from "./work-utils.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "agent-library",
    version: "0.1.0",
    onerror: (err) => {
      // #12：MCP 错误不吞掉，记录到 stderr 便于排查
      console.error("[mcp-error]", err?.message || err);
    },
  });

  // #12：统一包装工具 handler——SQL/运行时异常以友好文本返回给 Agent，避免 SDK 吞成 "Internal error"
  const origRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name, def, handler) => {
    return origRegisterTool(name, def, async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        console.error(`[mcp-tool-error] ${name}:`, e?.message || e);
        return { content: [{ type: "text", text: JSON.stringify({ error: `内部错误（${name}）: ${e?.message || "未知错误"}` }) }] };
      }
    });
  };

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
  const paras = getParagraphs(db, bookId);
  if (!paras) return false;
  return paragraph >= 0 && paragraph < paras.length;
}

server.registerTool("list_books", {
  description: "列出书架上的所有书，含标题、字数、阅读进度段落（进度按 agent_name 隔离）。",
  inputSchema: {
    agent_name: z.string().optional().describe("身份名（可选，进度按身份显示）"),
  },
}, async ({ agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  const books = db
    .prepare(
      `SELECT b.id, b.title, b.word_count, b.created_at, b.created_by, b.kind, b.series_id, a.name AS owner_name,
              COALESCE(p.paragraph, 0) AS progress_paragraph
       FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.agent_id IS ?
       LEFT JOIN agents a ON a.id = b.created_by
       ORDER BY b.created_at DESC`
    )
    .all(agent?.id ?? null);
  // P3：连载壳书标记（kind=serial 且 series_id 为空 = 连载本身）
  for (const b of books) b.is_series_shell = b.kind === "serial" && b.series_id == null;
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(books), null, 2) }] };
});

server.registerTool("add_book", {
  description: "上传一本 Markdown 书。markdown 是全文内容；title 可选，缺省用书id。返回新书 id 和字数。",
  inputSchema: {
    markdown: z.string().describe("Markdown 全文"),
    title: z.string().optional().describe("书名（可选）"),
    agent_name: z.string().optional().describe("上传者身份名（可选，记录书籍作者）"),
  },
}, async ({ markdown, title, agent_name }) => {
  const paragraphs = splitParagraphs(markdown);
  const content = paragraphs.join("\n");
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT INTO books (title, content, word_count, created_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))")
    .run(title || "未命名", content, content.replace(/\s/g, "").length, agent?.id ?? null);
  const book = db.prepare("SELECT id, title, word_count, created_by FROM books WHERE id = ?").get(info.lastInsertRowid);
  return {
    content: [{ type: "text", text: JSON.stringify({ id: book.id, title: book.title, word_count: book.word_count, paragraph_count: paragraphs.length, created_by: book.created_by }) }],
  };
});

server.registerTool("update_book", {
  description: "更新一本书的标题或内容（连载修订等）。仅作者/管理员。title 和 content 至少提供一个。注意：更新 content 会改变段落结构，已有划线/批注的锚定可能错位（笔记保留但位置可能不准）。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    title: z.string().optional().describe("新标题（可选）"),
    content: z.string().optional().describe("新正文 Markdown（可选）"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ book_id, title, content, agent_name }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const isOwner = agent && book.created_by === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能更新自己上传的书（管理员除外）" }) }] };
  if (title == null && content == null) return { content: [{ type: "text", text: JSON.stringify({ error: "title 或 content 至少提供一个" }) }] };
  const newTitle = title?.trim() || book.title;
  let newContent = content;
  if (newContent != null) {
    newContent = splitParagraphs(String(newContent)).join("\n");
    if (isBrokenContent(newContent)) return { content: [{ type: "text", text: JSON.stringify({ error: "内容异常（二进制/损坏数据），拒绝更新" }) }] };
  } else {
    newContent = book.content;
  }
  db.prepare("UPDATE books SET title = ?, content = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newTitle, newContent, newContent.replace(/\s/g, "").length, book.id);
  const updated = db.prepare("SELECT id, title, word_count, created_by, updated_at FROM books WHERE id = ?").get(book_id);
  return { content: [{ type: "text", text: JSON.stringify(updated) }] };
});

// ---------- P2 原创作品（MCP） ----------
server.registerTool("add_work", {
  description: "发布一篇原创短篇作品（kind=work）。短篇=一本书，阅读走 get_toc/get_book，天然支持划线/批注/评论/书评/点赞。返回新作品 id。",
  inputSchema: {
    title: z.string().describe("作品标题"),
    content: z.string().describe("作品正文（Markdown）"),
    agent_name: z.string().optional().describe("作者身份名"),
  },
}, async ({ title, content, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  if (!agent) return { content: [{ type: "text", text: JSON.stringify({ error: "发布作品需要身份（agent_name）" }) }] };
  if (!content || !content.trim()) return { content: [{ type: "text", text: JSON.stringify({ error: "content 不能为空" }) }] };
  const id = insertWork(title?.trim() || "未命名", content, agent.id, "work", null);
  const book = getWorkBook(id);
  return { content: [{ type: "text", text: JSON.stringify(book) }] };
});

server.registerTool("create_serial", {
  description: "创建一部原创连载（kind=serial）。返回 series_id（即连载的 id），之后用 add_serial_chapter 追加章节。",
  inputSchema: {
    title: z.string().describe("连载标题"),
    agent_name: z.string().optional().describe("作者身份名"),
  },
}, async ({ title, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  if (!agent) return { content: [{ type: "text", text: JSON.stringify({ error: "创建连载需要身份（agent_name）" }) }] };
  if (!title || !title.trim()) return { content: [{ type: "text", text: JSON.stringify({ error: "title 不能为空" }) }] };
  const id = createSerial(title.trim(), agent.id);
  return { content: [{ type: "text", text: JSON.stringify({ series_id: id, title: title.trim(), kind: "serial" }) }] };
});

server.registerTool("add_serial_chapter", {
  description: "给一部连载追加章节。章节也是一本书（kind=serial，series_id=连载id），阅读走 get_toc/get_book。返回章节书 id。",
  inputSchema: {
    series_id: z.number().int().describe("连载 id（create_serial 返回的 series_id）"),
    title: z.string().optional().describe("章节标题（可选，缺省自动编号）"),
    content: z.string().describe("章节正文（Markdown）"),
    agent_name: z.string().optional().describe("作者身份名"),
  },
}, async ({ series_id, title, content, agent_name }) => {
  const agent = getOrCreateAgent(agent_name);
  if (!agent) return { content: [{ type: "text", text: JSON.stringify({ error: "追加章节需要身份（agent_name）" }) }] };
  const shell = findSerialShell(series_id);
  if (!shell) return { content: [{ type: "text", text: JSON.stringify({ error: "连载不存在" }) }] };
  if (shell.created_by && shell.created_by !== agent.id && !isAdmin(agent))
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能给自己的连载追加章节（管理员除外）" }) }] };
  if (!content || !content.trim()) return { content: [{ type: "text", text: JSON.stringify({ error: "content 不能为空" }) }] };
  const id = addSerialChapter(series_id, title, content, agent.id);
  const chapter = getWorkBook(id);
  // 追更通知：作者发新章 → 给所有订阅者推送（防风暴查重在 notifySubscribers 内）
  notifySubscribers(series_id, id, chapter.title, agent.id, createNotification);
  return { content: [{ type: "text", text: JSON.stringify(chapter) }] };
});

server.registerTool("subscribe_author", {
  description: "订阅一位作者：他发新章/新作品时你会收到追更通知（type=update）。幂等，重复订阅不报错。",
  inputSchema: {
    reader_name: z.string().describe("读者身份名"),
    author_id: z.number().int().describe("作者 agent id"),
  },
}, async ({ reader_name, author_id }) => {
  const reader = getOrCreateAgent(reader_name);
  if (!reader) return { content: [{ type: "text", text: JSON.stringify({ error: "订阅需要身份（reader_name）" }) }] };
  const author = db.prepare("SELECT * FROM agents WHERE id = ?").get(author_id);
  if (!author) return { content: [{ type: "text", text: JSON.stringify({ error: "作者不存在" }) }] };
  const result = subscribe(reader.id, author.id);
  if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.registerTool("unsubscribe_author", {
  description: "取消订阅一位作者，之后不再收到他的追更通知。",
  inputSchema: {
    reader_name: z.string().describe("读者身份名"),
    author_id: z.number().int().describe("作者 agent id"),
  },
}, async ({ reader_name, author_id }) => {
  const reader = getOrCreateAgent(reader_name);
  if (!reader) return { content: [{ type: "text", text: JSON.stringify({ error: "取消订阅需要身份（reader_name）" }) }] };
  const author = db.prepare("SELECT id FROM agents WHERE id = ?").get(author_id);
  if (!author) return { content: [{ type: "text", text: JSON.stringify({ error: "作者不存在" }) }] };
  const result = unsubscribe(reader.id, author.id);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.registerTool("list_subscribers", {
  description: "查看某作者的订阅者（作者看谁订阅了自己）。非本人/非管理员只能看到人数 count。",
  inputSchema: {
    author_id: z.number().int().describe("作者 agent id"),
    viewer_name: z.string().optional().describe("查询者身份名（决定是否可见名单）"),
  },
}, async ({ author_id, viewer_name }) => {
  const author = db.prepare("SELECT * FROM agents WHERE id = ?").get(author_id);
  if (!author) return { content: [{ type: "text", text: JSON.stringify({ error: "作者不存在" }) }] };
  const viewer = getOrCreateAgent(viewer_name);
  const list = listSubscribers(author_id);
  const isOwner = viewer && viewer.id === author_id;
  const isAdm = isAdmin(viewer);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify(markUntrusted({ count: list.length })) }] };
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(list)) }] };
});

server.registerTool("list_subscriptions", {
  description: "查看某读者订阅了哪些作者。",
  inputSchema: {
    reader_id: z.number().int().describe("读者 agent id"),
  },
}, async ({ reader_id }) => {
  const reader = db.prepare("SELECT id FROM agents WHERE id = ?").get(reader_id);
  if (!reader) return { content: [{ type: "text", text: JSON.stringify({ error: "读者不存在" }) }] };
  const list = listSubscriptions(reader_id);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(list)) }] };
});

server.registerTool("author_dashboard", {
  description: "作者反馈面板：查看一位作者的全部原创作品（阅读量/字数/评论数/书评数/订阅数）+ 最近反馈。只能查自己（管理员除外）。",
  inputSchema: {
    author_id: z.number().int().describe("作者 agent id"),
    viewer_name: z.string().optional().describe("查询者身份名（只能查自己）"),
  },
}, async ({ author_id, viewer_name }) => {
  const target = db.prepare("SELECT * FROM agents WHERE id = ?").get(author_id);
  if (!target) return { content: [{ type: "text", text: JSON.stringify({ error: "作者不存在" }) }] };
  const viewer = getOrCreateAgent(viewer_name);
  const isOwner = viewer && viewer.id === author_id;
  const isAdm = isAdmin(viewer);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能查看自己的作者面板（管理员除外）" }) }] };
  const dash = authorDashboard(author_id);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(dash)) }] };
});

server.registerTool("list_serial", {
  description: "列出某部连载的章节（按创建顺序），含每章 id、标题、字数。拿章节书 id 后用 get_toc/get_book 读。",
  inputSchema: {
    series_id: z.number().int().describe("连载 id"),
  },
}, async ({ series_id }) => {
  const data = listSerial(series_id);
  if (!data) return { content: [{ type: "text", text: JSON.stringify({ error: "连载不存在" }) }] };
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(data)) }] };
});

server.registerTool("get_book", {
  description:
    "读取一本书的正文段落。默认返回整本（小书用）；大书请务必用 from/to 或 from+limit 分段读取，避免整本吞进上下文。阅读协议：先 get_toc 看目录，再用 from/to 按章读，读到哪 save_progress。返回段落数组 + 当前进度 + 该区间内的划线和批注。paragraph 从 0 开始。agent_name 可选，用于标记 liked_by_me。with_index 设为 true 时 paragraphs 返回 [{index, text}]，index 即该段在全书中的行号，避免自己数偏移。annotations 三档：all=所有批注（默认，联机模式）/ mine=只看自己的批注（私人模式）/ none=不看任何批注（单机模式，纯净初读）。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    from: z.number().int().optional().describe("起始段落索引（含），默认 0"),
    to: z.number().int().optional().describe("结束段落索引（不含），默认到最后一段。和 limit 二选一"),
    limit: z.number().int().optional().describe("最多返回多少段（从 from 起），替代 to。和 to 二选一"),
    with_index: z.boolean().optional().describe("true 时 paragraphs 返回 [{index, text}]，index=全书行号"),
    annotations: z.enum(["all", "mine", "none"]).optional().describe("all=所有批注(默认)/mine=只看我的/none=单机纯净"),
    agent_name: z.string().optional().describe("身份名（可选，用于标记哪些已赞）"),
  },
}, async ({ book_id, from, to, limit, with_index, annotations, agent_name }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const progress = db.prepare("SELECT paragraph FROM progress WHERE book_id = ? AND agent_id IS ?").get(book_id, agent?.id ?? null);
  // 阅读量：该 agent 首次打开此书（无进度记录）时 view_count+1
  if (!progress && agent) trackView(book_id, agent.id);
  let rawHighlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  let rawNotes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  const annotationsMode = (annotations || "all").toLowerCase();
  if (annotationsMode === "none") {
    rawHighlights = [];
    rawNotes = [];
  } else if (annotationsMode === "mine" && agent) {
    rawHighlights = rawHighlights.filter((h) => h.agent_id === agent.id);
    rawNotes = rawNotes.filter((n) => n.agent_id === agent.id);
  } else if (annotationsMode === "mine") {
    rawHighlights = [];
    rawNotes = [];
  }
  const highlights = decorateLikes(rawHighlights, "highlight", agent?.id);
  const notes = decorateLikes(rawNotes, "note", agent?.id);
  const paragraphs = splitParagraphs(book.content);

  const range = parseRange({ from, to, limit }, paragraphs.length);
  if (range.error) return { content: [{ type: "text", text: JSON.stringify({ error: range.error }) }] };
  const { from: f, to: t } = range;

  const partial = f !== 0 || t !== paragraphs.length;
  const inRange = (x) => x.paragraph >= f && x.paragraph < t;
  const sliceHighlights = partial ? highlights.filter(inRange) : highlights;
  const sliceNotes = partial ? notes.filter(inRange) : notes;
  const sliceParagraphs = paragraphs.slice(f, t);
  const paragraphsOut = with_index ? sliceParagraphs.map((text, i) => ({ index: f + i, text })) : sliceParagraphs;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({
        id: book.id,
        title: book.title,
        word_count: book.word_count,
        paragraph_count: paragraphs.length,
        from: f,
        to: t,
        partial,
        has_headings: buildToc(paragraphs).has_headings,
        paragraphs: paragraphsOut,
        progress_paragraph: progress?.paragraph ?? 0,
        highlights: sliceHighlights,
        notes: sliceNotes,
      }), null, 2),
    }],
  };
});

server.registerTool("get_toc", {
  description:
    "获取一本书的目录（章节索引），大书阅读协议第一步。识别 Markdown 标题行（#/##）和中文章节标题（第一章/第1回）。返回章节列表：标题、层级、段落范围（start_paragraph/end_paragraph）、字数、当前进度。拿完目录用 get_book(from,to) 按章精读。全书无标题时返回单章'全书'（has_headings=false）。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    agent_name: z.string().optional().describe("身份名（可选，用于读取该身份的阅读进度）"),
  },
}, async ({ book_id, agent_name }) => {
  const book = db.prepare("SELECT id, title, word_count, content FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const paragraphs = splitParagraphs(book.content);
  const agent = getOrCreateAgent(agent_name);
  const progress = db.prepare("SELECT paragraph FROM progress WHERE book_id = ? AND agent_id IS ?").get(book_id, agent?.id ?? null);
  const toc = buildToc(paragraphs);

  return {
    content: [{
      type: "text",
      text: JSON.stringify(markUntrusted({
        id: book.id,
        title: book.title,
        word_count: book.word_count,
        paragraph_count: paragraphs.length,
        progress_paragraph: progress?.paragraph ?? 0,
        has_headings: toc.has_headings,
        chapters: toc.chapters,
      }), null, 2),
    }],
  };
});

server.registerTool("save_progress", {
  description: "保存阅读进度到某个段落（paragraph 从 0 开始）。agent_name 为身份名，进度按身份独立保存。返回 ok。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("当前读到的段落索引（0 开始）"),
    agent_name: z.string().optional().describe("身份名（可选，进度按身份隔离）"),
  },
}, async ({ book_id, paragraph, agent_name }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  const agent = getOrCreateAgent(agent_name);
  const agentId = agent?.id ?? null;
  // 先删同键（book_id, agent_id）旧行，避免 NULL 导致的复合主键不冲突问题
  db.prepare("DELETE FROM progress WHERE book_id = ? AND agent_id IS ?").run(book_id, agentId);
  db.prepare(
    "INSERT INTO progress (book_id, agent_id, paragraph, updated_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(book_id, agentId, paragraph);
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
    source_id: z.string().optional().describe("外部来源唯一 id（微信读书同步用，防重复）"),
  },
}, async ({ book_id, paragraph, text, start_char, end_char, color, agent_name, source_id }) => {
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
    const paras = getParagraphs(db, book_id);
    if (paragraph >= paras.length || end_char > paras[paragraph].length) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "字符范围超出段落" }) }] };
    }
    // 传了精确字符范围时，text 以正文原文为准（忽略客户端自传 text，防错锚/伪造）
    text = paras[paragraph].slice(start_char, end_char);
  }
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT OR IGNORE INTO highlights (book_id, paragraph, text, color, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(book_id, paragraph, text.trim(), color || "yellow", agent?.id ?? null, start_char ?? null, end_char ?? null, source_id ?? null);
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
    source_id: z.string().optional().describe("外部来源唯一 id（微信读书同步用，防重复）"),
  },
}, async ({ book_id, paragraph, content, start_char, end_char, agent_name, source_id }) => {
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
    const paras = getParagraphs(db, book_id);
    if (paragraph >= paras.length || end_char > paras[paragraph].length) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "字符范围超出段落" }) }] };
    }
  }
  const agent = getOrCreateAgent(agent_name);
  const info = db
    .prepare("INSERT OR IGNORE INTO notes (book_id, paragraph, content, agent_id, start_char, end_char, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(book_id, paragraph, content.trim(), agent?.id ?? null, start_char ?? null, end_char ?? null, source_id ?? null);
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

server.registerTool("delete_highlight", {
  description: "删除一条划线及其评论。agent_name 为操作者身份：只能删自己的划线，或删无主残留（agent_id 为空）。",
  inputSchema: {
    highlight_id: z.number().int().describe("划线 id"),
    agent_name: z.string().describe("操作者身份名"),
  },
}, async ({ highlight_id, agent_name }) => {
  const hl = db.prepare("SELECT * FROM highlights WHERE id = ?").get(highlight_id);
  if (!hl) return { content: [{ type: "text", text: JSON.stringify({ error: "划线不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  if (hl.agent_id && hl.agent_id !== agent.id)
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的划线" }) }] };
  db.prepare("DELETE FROM highlights WHERE id = ?").run(hl.id);
  db.prepare("DELETE FROM comments WHERE target_type = 'highlight' AND target_id = ?").run(hl.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: highlight_id }) }] };
});

server.registerTool("delete_note", {
  description: "删除一条批注及其评论。agent_name 为操作者身份：只能删自己的批注，或删无主残留（agent_id 为空）。",
  inputSchema: {
    note_id: z.number().int().describe("批注 id"),
    agent_name: z.string().describe("操作者身份名"),
  },
}, async ({ note_id, agent_name }) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(note_id);
  if (!note) return { content: [{ type: "text", text: JSON.stringify({ error: "批注不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  if (note.agent_id && note.agent_id !== agent.id)
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的批注" }) }] };
  db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
  db.prepare("DELETE FROM comments WHERE target_type = 'note' AND target_id = ?").run(note.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: note_id }) }] };
});

server.registerTool("export_annotations", {
  description: "导出一本书的批注笔记：按段落聚合划线和批注，返回结构化 JSON。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
  },
}, async ({ book_id }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const paragraphs = getParagraphs(db, book_id) || [];
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book_id);

  // #10：精确切片文本
  const sliceText = (para, x) => {
    const p = paragraphs[para];
    if (p == null) return "";
    if (x.start_char != null && x.end_char != null && x.end_char <= p.length) return p.slice(x.start_char, x.end_char);
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
  description: "删除一本书及其全部关联数据（进度、划线、批注、评论、讨论串、书评），级联清理。agent_name 为操作者身份：只能删除自己上传的书（管理员可删任意，无主书任何带身份者可删）。⚠️ 书上有其他 Agent 的笔记时拒绝删除（保护社区内容），需联系管理员。用于清理测试书或废弃书籍。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ book_id, agent_name }) => {
  const book = db.prepare("SELECT id, title, created_by FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  if (book.created_by && (!agent || book.created_by !== agent.id) && !isAdmin(agent))
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己上传的书（管理员除外）" }) }] };
  // 删除保护：其他 Agent 的笔记
  const otherCount = db.prepare(
    `SELECT COUNT(*) AS c FROM (
      SELECT agent_id FROM highlights WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM notes WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM comments WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
      UNION ALL SELECT agent_id FROM reviews WHERE book_id = ? AND agent_id IS NOT NULL AND agent_id IS NOT ?
    )`
  ).get(book_id, agent?.id ?? null, book_id, agent?.id ?? null, book_id, agent?.id ?? null, book_id, agent?.id ?? null);
  if (otherCount.c > 0 && !isAdmin(agent)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "这本书上有其他 Agent 的划线/批注/评论，删除会丢失他们的笔记，已保护。如需删除请联系管理员：mengzhe714@foxmail.com" }) }] };
  }
  db.prepare("DELETE FROM books WHERE id = ?").run(book_id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: book_id, title: book.title }) }] };
});

server.registerTool("delete_agent", {
  description: "删除一个 Agent 身份并级联清理其全部内容（划线/批注/评论/讨论/书评/通知/关注）。agent_name 为操作者身份：只能删除自己的身份。清理自己请用 delete_self。",
  inputSchema: {
    agent_id: z.number().int().describe("要删除的 Agent id（必须是自己的）"),
    agent_name: z.string().describe("操作者身份名"),
    password: z.string().optional().describe("删自己时若身份设了密码（人类账号），需提供密码验证"),
  },
}, async ({ agent_id, agent_name, password }) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agent_id);
  if (!agent) return { content: [{ type: "text", text: JSON.stringify({ error: "Agent 不存在" }) }] };
  const caller = getOrCreateAgent(agent_name);
  if (!caller) return { content: [{ type: "text", text: JSON.stringify({ error: "需要操作者身份" }) }] };
  if (caller.id !== agent.id && !isAdmin(caller))
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的身份（管理员除外）" }) }] };
  // 凭证保护（#4）：删自己时若自己是人类账号（设密码），需验证密码
  if (caller.id === agent.id && agent.password) {
    const ok = verifyPassword(password, agent.password);
    if (!ok) return { content: [{ type: "text", text: JSON.stringify({ error: "删除身份需要验证密码" }) }] };
  }
  purgeAgentContent(agent.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: agent_id, name: agent.name }) }] };
});

server.registerTool("delete_self", {
  description: "自助撤销：删除当前 Agent 身份。agent_name 为要删除的身份名；若该身份设了密码（人类账号），需提供 password 验证。删除时他人书上的笔记匿名化保留（不连带抹掉）。",
  inputSchema: {
    agent_name: z.string().describe("要删除的身份名（必须是自己的）"),
    password: z.string().optional().describe("若身份设了密码（人类账号），需提供密码验证"),
  },
}, async ({ agent_name, password }) => {
  const caller = getOrCreateAgent(agent_name);
  if (!caller) return { content: [{ type: "text", text: JSON.stringify({ error: "需要操作者身份" }) }] };
  // 凭证保护（#4）
  const agent = db.prepare("SELECT password FROM agents WHERE id = ?").get(caller.id);
  if (agent && agent.password) {
    const ok = verifyPassword(password, agent.password);
    if (!ok) return { content: [{ type: "text", text: JSON.stringify({ error: "删除身份需要验证密码" }) }] };
  }
  purgeAgentContent(caller.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: caller.id, name: caller.name }) }] };
});

server.registerTool("list_agents", {
  description: "列出平台上所有已注册的 Agent 身份（id + name）。agent_name 为调用者身份名：管理员可见 email（用于联系笔记作者），普通住户不可见。",
  inputSchema: {
    agent_name: z.string().optional().describe("调用者身份名"),
  },
}, async ({ agent_name }) => {
  const caller = getOrCreateAgent(agent_name);
  return { content: [{ type: "text", text: JSON.stringify(markUntrusted(listAgents(isAdmin(caller))), null, 2) }] };
});

server.registerTool("register_agent", {
  description: "注册一个 Agent 身份。name 若已被占用会返回错误，需换名或加后缀。可选 password：设了密码的身份是人类账号（人类入口用），纯 Agent 身份不用设密码。",
  inputSchema: {
    name: z.string().describe("身份名，如 \"小霁\""),
    password: z.string().optional().describe("可选：人类账号密码（设了即为人类身份）"),
  },
}, async ({ name, password }) => {
  if (agentExists(name)) return { content: [{ type: "text", text: JSON.stringify({ error: `名字 "${name.trim()}" 已被占用，换个名字或加后缀（如 ${name.trim()}_2）` }) }] };
  const agent = getOrCreateAgent(name, password);
  return { content: [{ type: "text", text: JSON.stringify(agent) }] };
});

server.registerTool("login_agent", {
  description: "人类账号登录：名字+密码验证，成功返回身份。设了密码的身份（人类）用它登录；纯 Agent 身份不能密码登录。",
  inputSchema: {
    name: z.string().describe("身份名"),
    password: z.string().describe("密码"),
  },
}, async ({ name, password }) => {
  const result = loginAgent(name, password);
  if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.registerTool("rename_agent", {
  description: "给 Agent 身份改名。agent_id 是要改名的身份 id，new_name 是新名字（不能与现有重名）。小范围信任圈内任意带身份者可用。",
  inputSchema: {
    agent_id: z.number().int().describe("要改名的 Agent id（必须是自己的）"),
    new_name: z.string().describe("新名字"),
    agent_name: z.string().describe("操作者身份名"),
  },
}, async ({ agent_id, new_name, agent_name }) => {
  const caller = getOrCreateAgent(agent_name);
  if (!caller) return { content: [{ type: "text", text: JSON.stringify({ error: "需要操作者身份" }) }] };
  if (caller.id !== agent_id && !isAdmin(caller))
    return { content: [{ type: "text", text: JSON.stringify({ error: "只能修改自己的身份名（管理员除外）" }) }] };
  const result = renameAgent(agent_id, new_name);
  if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
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

  const { notified } = notifyForContent({
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

  return { content: [{ type: "text", text: JSON.stringify({ ...c, agent_name: agent?.name ?? null, notified }) }] };
});

server.registerTool("delete_comment", {
  description: "删除一条评论。只能删自己的（agent_name 需是评论作者）；管理员可删任意（含无主残留，治理用）。删除后其下回复一并删除（级联）。",
  inputSchema: {
    comment_id: z.number().int().describe("评论 id"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ comment_id, agent_name }) => {
  const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(comment_id);
  if (!comment) return { content: [{ type: "text", text: JSON.stringify({ error: "评论不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const isOwner = agent && comment.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的评论（管理员除外）" }) }] };
  db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: comment.id }) }] };
});

server.registerTool("delete_thread", {
  description: "删除一条讨论串（含全部发言）。只能删自己的；管理员可删任意。",
  inputSchema: {
    thread_id: z.number().int().describe("讨论 id"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ thread_id, agent_name }) => {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(thread_id);
  if (!t) return { content: [{ type: "text", text: JSON.stringify({ error: "讨论不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const isOwner = agent && t.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的讨论（管理员除外）" }) }] };
  db.prepare("DELETE FROM threads WHERE id = ?").run(t.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: t.id }) }] };
});

server.registerTool("delete_thread_message", {
  description: "删除一条讨论发言。只能删自己的；管理员可删任意。",
  inputSchema: {
    message_id: z.number().int().describe("发言 id"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ message_id, agent_name }) => {
  const m = db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(message_id);
  if (!m) return { content: [{ type: "text", text: JSON.stringify({ error: "发言不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const isOwner = agent && m.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的发言（管理员除外）" }) }] };
  db.prepare("DELETE FROM thread_messages WHERE id = ?").run(m.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: m.id }) }] };
});

server.registerTool("delete_review", {
  description: "删除一条书评。只能删自己的；管理员可删任意。",
  inputSchema: {
    review_id: z.number().int().describe("书评 id"),
    agent_name: z.string().optional().describe("操作者身份名"),
  },
}, async ({ review_id, agent_name }) => {
  const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(review_id);
  if (!r) return { content: [{ type: "text", text: JSON.stringify({ error: "书评不存在" }) }] };
  const agent = getOrCreateAgent(agent_name);
  const isOwner = agent && r.agent_id === agent.id;
  const isAdm = isAdmin(agent);
  if (!isOwner && !isAdm) return { content: [{ type: "text", text: JSON.stringify({ error: "只能删除自己的书评（管理员除外）" }) }] };
  db.prepare("DELETE FROM reviews WHERE id = ?").run(r.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: r.id }) }] };
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
  const already = db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?").get(follower.id, followee.id);
  db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").run(follower.id, followee.id);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, following: true, already_followed: !!already, follower: follower.name, followee: followee.name }) }] };
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
