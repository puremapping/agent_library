import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import db from "./db.js";

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
  return { content: [{ type: "text", text: JSON.stringify(books, null, 2) }] };
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
  description: "读取一本书：返回正文（按非空行切分成段落数组）、当前进度、所有划线和批注。paragraph 从 0 开始。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
  },
}, async ({ book_id }) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(book_id);
  if (!book) return { content: [{ type: "text", text: JSON.stringify({ error: "书不存在" }) }] };
  const progress = db.prepare("SELECT paragraph FROM progress WHERE book_id = ?").get(book_id);
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book_id);
  const paragraphs = splitParagraphs(book.content);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        id: book.id,
        title: book.title,
        word_count: book.word_count,
        paragraph_count: paragraphs.length,
        paragraphs,
        progress_paragraph: progress?.paragraph ?? 0,
        highlights,
        notes,
      }, null, 2),
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
  description: "给某本书的某个段落划一条高亮线。paragraph 从 0 开始；color 可选 yellow/blue/green。返回新高亮记录。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("段落索引（0 开始）"),
    text: z.string().describe("被划线的原文文本"),
    color: z.enum(["yellow", "blue", "green"]).optional().describe("可选，默认 yellow"),
  },
}, async ({ book_id, paragraph, text, color }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  const info = db
    .prepare("INSERT INTO highlights (book_id, paragraph, text, color) VALUES (?, ?, ?, ?)")
    .run(book_id, paragraph, text.trim(), color || "yellow");
  const h = db.prepare("SELECT * FROM highlights WHERE id = ?").get(info.lastInsertRowid);
  return { content: [{ type: "text", text: JSON.stringify(h) }] };
});

server.registerTool("add_note", {
  description: "给某本书的某个段落写一条批注。paragraph 从 0 开始。返回新批注记录。",
  inputSchema: {
    book_id: z.number().int().describe("书 id"),
    paragraph: z.number().int().describe("段落索引（0 开始）"),
    content: z.string().describe("批注内容"),
  },
}, async ({ book_id, paragraph, content }) => {
  if (!paragraphWithinRange(book_id, paragraph)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "paragraph 超出正文范围" }) }] };
  }
  const info = db
    .prepare("INSERT INTO notes (book_id, paragraph, content) VALUES (?, ?, ?)")
    .run(book_id, paragraph, content.trim());
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(info.lastInsertRowid);
  return { content: [{ type: "text", text: JSON.stringify(n) }] };
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
      text: JSON.stringify({
        book: { id: book.id, title: book.title },
        annotations: [...byParagraph.values()],
      }, null, 2),
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
