import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));
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
  res.json(books);
});

app.get("/api/books/:id", (req, res) => {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
  if (!book) return res.status(404).json({ error: "书不存在" });

  const progress = db.prepare("SELECT * FROM progress WHERE book_id = ?").get(book.id);
  const highlights = db.prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY paragraph, id").all(book.id);
  const notes = db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY paragraph, id").all(book.id);

  res.json({ ...book, progress_paragraph: progress?.paragraph ?? 0, highlights, notes });
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

  const info = db
    .prepare("INSERT INTO highlights (book_id, paragraph, text, color) VALUES (?, ?, ?, ?)")
    .run(req.params.id, paragraph, text.trim(), color || "yellow");

  res.status(201).json(db.prepare("SELECT * FROM highlights WHERE id = ?").get(info.lastInsertRowid));
});

app.post("/api/books/:id/notes", (req, res) => {
  const { paragraph, content } = req.body;
  if (!Number.isInteger(paragraph) || !content?.trim())
    return res.status(400).json({ error: "paragraph 和 content 必填" });
  if (!paragraphWithinRange(req.params.id, paragraph))
    return res.status(400).json({ error: "paragraph 超出正文范围" });

  const info = db
    .prepare("INSERT INTO notes (book_id, paragraph, content) VALUES (?, ?, ?)")
    .run(req.params.id, paragraph, content.trim());

  res.status(201).json(db.prepare("SELECT * FROM notes WHERE id = ?").get(info.lastInsertRowid));
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
    book: { id: book.id, title: book.title },
    annotations: [...byParagraph.values()],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`agent-library 运行在 http://localhost:${PORT}`));
