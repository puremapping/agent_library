// P2 原创作品共享逻辑：短篇/连载的发布与查询
// 供 server.js（REST）与 mcp-server.js（MCP）共用，保证行为一致。
import db from "./db.js";
import { splitParagraphs } from "./book-utils.js";

// 短篇：kind=work，series_id=NULL
// 连载：create_serial 建 kind=serial 的空壳书（id 即 series_id），add_serial_chapter 追加章节书（series_id=壳id）
export function insertWork(title, content, agentId, kind, seriesId) {
  const paragraphs = splitParagraphs(content);
  const text = paragraphs.join("\n");
  const info = db
    .prepare("INSERT INTO books (title, content, word_count, created_by, kind, series_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
    .run(title, text, text.replace(/\s/g, "").length, agentId ?? null, kind, seriesId ?? null);
  return info.lastInsertRowid;
}

export function getWorkBook(id) {
  return db.prepare("SELECT id, title, word_count, created_by, kind, series_id, created_at, updated_at FROM books WHERE id = ?").get(id);
}

// 找连载壳书（id 匹配且 kind=serial）
export function findSerialShell(seriesId) {
  return db.prepare("SELECT * FROM books WHERE id = ? AND kind = 'serial'").get(seriesId);
}

export function createSerial(title, agentId) {
  return insertWork(title, "", agentId, "serial", null);
}

export function addSerialChapter(seriesId, title, content, agentId) {
  const count = db.prepare("SELECT COUNT(*) c FROM books WHERE series_id = ?").get(seriesId).c;
  const chapterTitle = title?.trim() || `第${count + 1}章`;
  return insertWork(chapterTitle, content, agentId, "serial", seriesId);
}

export function listSerial(seriesId) {
  const shell = findSerialShell(seriesId);
  if (!shell) return null;
  const chapters = db
    .prepare("SELECT id, title, word_count, created_at FROM books WHERE series_id = ? AND id != ? ORDER BY created_at ASC, id ASC")
    .all(seriesId, seriesId);
  return { series_id: seriesId, title: shell.title, chapters };
}
