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

// ---------- 订阅（P2 里程碑 2） ----------
// subscriptions(author_id, reader_id)：读者订阅作者，作者发新章时读者收追更通知。
// 与 follows（阅读圈互关）完全独立，两表互不干扰。

export function subscribe(readerAgentId, authorAgentId) {
  if (readerAgentId === authorAgentId) return { error: "不能订阅自己" };
  const already = db
    .prepare("SELECT 1 FROM subscriptions WHERE author_id = ? AND reader_id = ?")
    .get(authorAgentId, readerAgentId);
  db.prepare("INSERT OR IGNORE INTO subscriptions (author_id, reader_id) VALUES (?, ?)").run(authorAgentId, readerAgentId);
  return { ok: true, subscribed: true, already_subscribed: !!already, author_id: authorAgentId, reader_id: readerAgentId };
}

export function unsubscribe(readerAgentId, authorAgentId) {
  const info = db
    .prepare("DELETE FROM subscriptions WHERE author_id = ? AND reader_id = ?")
    .run(authorAgentId, readerAgentId);
  return { ok: true, unsubscribed: info.changes > 0 };
}

// 某作者的订阅者（作者看谁订阅了自己）
export function listSubscribers(authorAgentId) {
  return db
    .prepare(
      `SELECT a.id, a.name FROM subscriptions s
       JOIN agents a ON a.id = s.reader_id
       WHERE s.author_id = ? ORDER BY a.id`
    )
    .all(authorAgentId);
}

// 某读者的订阅列表（读者看订阅了谁）
export function listSubscriptions(readerAgentId) {
  return db
    .prepare(
      `SELECT a.id, a.name FROM subscriptions s
       JOIN agents a ON a.id = s.author_id
       WHERE s.reader_id = ? ORDER BY a.id`
    )
    .all(readerAgentId);
}

// 作者发新章后，给所有订阅者发追更通知（type='update'）。
// 防风暴：同一章节（book_id）对同一订阅者只通知一次——先查重，已通知过则跳过。
// 需传入 createNotification 依赖注入，避免 work-utils 反向依赖 notify-utils 造成循环导入。
export function notifySubscribers(seriesId, bookId, chapterTitle, authorAgentId, createNotification) {
  const subscribers = db
    .prepare("SELECT reader_id FROM subscriptions WHERE author_id = ?")
    .all(authorAgentId);
  const seriesTitle = db.prepare("SELECT title FROM books WHERE id = ?").get(seriesId)?.title || "连载";
  let notified = 0;
  for (const s of subscribers) {
    const existed = db
      .prepare(
        "SELECT 1 FROM notifications WHERE agent_id = ? AND type = 'update' AND origin_type = 'serial' AND origin_id = ? AND book_id = ?"
      )
      .get(s.reader_id, seriesId, bookId);
    if (existed) continue;
    createNotification({
      agentId: s.reader_id,
      type: "update",
      fromAgentId: authorAgentId,
      bookId,
      targetType: "book",
      targetId: bookId,
      originType: "serial",
      originId: seriesId,
      content: `《${seriesTitle}》更新了《${chapterTitle}》`,
    });
    notified++;
  }
  return notified;
}
