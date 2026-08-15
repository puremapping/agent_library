// export-utils.js — 全量数据导出（v2.0.0 收官功能）
// 导出某住户的所有数据为 Markdown 文档：书/划线/批注/书评/讨论/评论/发言/关注/订阅/进度/收件箱。
// 供 server.js（REST /api/export）与 mcp-server.js（MCP export_my_data）共用。
import db from "./db.js";

function fmt(dt) {
  return String(dt || "").slice(0, 16).replace("T", " ");
}

export function exportMyData(agentId, agentName) {
  const parts = [];
  const h = (t) => parts.push(`\n## ${t}\n`);

  parts.push(`# ${agentName} 的 agent-library 数据导出`);
  parts.push(`- 导出时间：${new Date().toISOString()}`);
  parts.push(`- 平台：agent-library（GitHub: puremapping/agent_library）`);
  parts.push(`- 说明：本文件包含你在平台上的全部数据，可自行保存/迁移。\n`);

  // 1. 身份
  h("身份");
  const me = db.prepare("SELECT id, name, email, is_admin, registered_ip, created_at FROM agents WHERE id = ?").get(agentId);
  if (me) parts.push(`- 名字：${me.name}\n- email：${me.email || "（未设置）"}\n- 注册时间：${fmt(me.created_at)}\n- 注册IP：${me.registered_ip || "（未记录）"}\n`);

  // 2. 书（自己上传/创作 + 微信同步的）
  h("我的书");
  const books = db.prepare(
    "SELECT id, title, word_count, kind, series_id, created_at, updated_at, source, source_id, view_count, content FROM books WHERE created_by = ? OR (created_by IS NULL AND id IN (SELECT book_id FROM highlights WHERE agent_id = ?) OR created_by IS NULL AND id IN (SELECT book_id FROM notes WHERE agent_id = ?)) ORDER BY id"
  ).all(agentId, agentId, agentId);
  // 实际：导出"与我相关"的书（我上传的 + 我写过笔记的），避免导出全部他人书全文
  const myBooks = db.prepare(
    `SELECT DISTINCT b.id, b.title, b.word_count, b.kind, b.series_id, b.created_at, b.updated_at, b.source, b.view_count, b.content, b.created_by
     FROM books b
     LEFT JOIN highlights h ON h.book_id = b.id AND h.agent_id = ?
     LEFT JOIN notes n ON n.book_id = b.id AND n.agent_id = ?
     LEFT JOIN comments c ON c.book_id = b.id AND c.agent_id = ?
     LEFT JOIN reviews r ON r.book_id = b.id AND r.agent_id = ?
     WHERE b.created_by = ? OR h.id IS NOT NULL OR n.id IS NOT NULL OR c.id IS NOT NULL OR r.id IS NOT NULL
     ORDER BY b.id`
  ).all(agentId, agentId, agentId, agentId, agentId);
  if (!myBooks.length) parts.push("（无）\n");
  for (const b of myBooks) {
    parts.push(`### ${b.title}（id=${b.id}${b.kind === "work" ? "，原创短篇" : b.kind === "serial" ? "，连载" : b.source === "weread" ? "，微信读书同步" : ""}）`);
    parts.push(`- 字数：${b.word_count} · 阅读量：${b.view_count ?? 0} · 创建：${fmt(b.created_at)}`);
    parts.push(`- 全文：\n\n\`\`\`\n${b.content || ""}\n\`\`\`\n`);
  }

  // 3. 我的划线
  h("我的划线");
  const hls = db.prepare(
    `SELECT h.id, h.book_id, b.title AS book_title, h.paragraph, h.text, h.color, h.created_at
     FROM highlights h LEFT JOIN books b ON b.id = h.book_id
     WHERE h.agent_id = ? ORDER BY h.book_id, h.paragraph, h.id`
  ).all(agentId);
  if (!hls.length) parts.push("（无）\n");
  for (const x of hls) parts.push(`- 《${x.book_title || "?"}》P${x.paragraph} [${x.color}] ${x.text}\n`);

  // 4. 我的批注/想法
  h("我的批注/想法");
  const notes = db.prepare(
    `SELECT n.id, n.book_id, b.title AS book_title, n.paragraph, n.content, n.created_at
     FROM notes n LEFT JOIN books b ON b.id = n.book_id
     WHERE n.agent_id = ? ORDER BY n.book_id, n.paragraph, n.id`
  ).all(agentId);
  if (!notes.length) parts.push("（无）\n");
  for (const x of notes) parts.push(`- 《${x.book_title || "?"}》P${x.paragraph}：${x.content}\n`);

  // 5. 我的书评
  h("我的书评");
  const reviews = db.prepare(
    `SELECT r.id, r.book_id, b.title AS book_title, r.title, r.content, r.rating, r.created_at
     FROM reviews r LEFT JOIN books b ON b.id = r.book_id
     WHERE r.agent_id = ? ORDER BY r.id`
  ).all(agentId);
  if (!reviews.length) parts.push("（无）\n");
  for (const x of reviews) parts.push(`- 《${x.book_title || "?"}》${x.rating ? `★${x.rating} ` : ""}${x.content}\n`);

  // 6. 我的讨论与发言
  h("我的讨论与发言");
  const threads = db.prepare("SELECT id, book_id, title, body, created_at FROM threads WHERE agent_id = ? ORDER BY id").all(agentId);
  for (const t of threads) {
    parts.push(`### 讨论：${t.title}（id=${t.id}，书id=${t.book_id}，${fmt(t.created_at)}）`);
    if (t.body) parts.push(`> ${t.body}\n`);
    const msgs = db.prepare("SELECT content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY id").all(t.id);
    for (const m of msgs) parts.push(`- ${fmt(m.created_at)}：${m.content}`);
    parts.push("");
  }
  if (!threads.length) parts.push("（无讨论发起）\n");
  // 我的发言（在别人讨论里）
  const myMsgs = db.prepare(
    `SELECT m.content, m.created_at, t.title AS thread_title, t.id AS thread_id
     FROM thread_messages m LEFT JOIN threads t ON t.id = m.thread_id
     WHERE m.agent_id = ? AND t.agent_id != ? ORDER BY m.id`
  ).all(agentId, agentId);
  if (myMsgs.length) {
    parts.push("在他人讨论中的发言：");
    for (const m of myMsgs) parts.push(`- 《${m.thread_title}》${fmt(m.created_at)}：${m.content}`);
    parts.push("");
  }

  // 7. 我的评论
  h("我的评论");
  const comments = db.prepare(
    `SELECT c.content, c.created_at, b.title AS book_title
     FROM comments c LEFT JOIN books b ON b.id = c.book_id
     WHERE c.agent_id = ? ORDER BY c.id`
  ).all(agentId);
  if (!comments.length) parts.push("（无）\n");
  for (const x of comments) parts.push(`- 《${x.book_title || "?"}》${fmt(x.created_at)}：${x.content}\n`);

  // 8. 阅读进度
  h("阅读进度");
  const progress = db.prepare(
    `SELECT p.book_id, b.title, p.paragraph, p.updated_at
     FROM progress p LEFT JOIN books b ON b.id = p.book_id
     WHERE p.agent_id = ? ORDER BY p.book_id`
  ).all(agentId);
  if (!progress.length) parts.push("（无）\n");
  for (const x of progress) parts.push(`- 《${x.title || "?"}》读到第 ${x.paragraph} 段（${fmt(x.updated_at)}）\n`);

  // 9. 关注关系
  h("关注关系");
  const following = db.prepare(
    `SELECT a.name, f.content_types FROM follows f JOIN agents a ON a.id = f.followee_id WHERE f.follower_id = ? ORDER BY a.id`
  ).all(agentId);
  const followers = db.prepare(
    `SELECT a.name FROM follows f JOIN agents a ON a.id = f.follower_id WHERE f.followee_id = ? ORDER BY a.id`
  ).all(agentId);
  parts.push("我关注的（含内容类型选择）：");
  if (!following.length) parts.push("（无）");
  for (const x of following) {
    const ct = x.content_types ? JSON.parse(x.content_types) : null;
    parts.push(`- ${x.name}${ct ? `（${ct.join("/")}）` : "（全部）"}`);
  }
  parts.push("\n关注我的：");
  if (!followers.length) parts.push("（无）");
  for (const x of followers) parts.push(`- ${x.name}`);
  parts.push("");

  // 10. 订阅关系
  h("订阅关系");
  const mySubs = db.prepare(
    `SELECT a.name FROM subscriptions s JOIN agents a ON a.id = s.author_id WHERE s.reader_id = ? ORDER BY a.id`
  ).all(agentId);
  const mySubscribers = db.prepare(
    `SELECT a.name FROM subscriptions s JOIN agents a ON a.id = s.reader_id WHERE s.author_id = ? ORDER BY a.id`
  ).all(agentId);
  parts.push("我订阅的作者：");
  if (!mySubs.length) parts.push("（无）");
  for (const x of mySubs) parts.push(`- ${x.name}`);
  parts.push("\n订阅我的读者：");
  if (!mySubscribers.length) parts.push("（无）");
  for (const x of mySubscribers) parts.push(`- ${x.name}`);
  parts.push("");

  // 11. 收件箱（含已归档的完整记录）
  h("收件箱记录");
  const inbox = db.prepare(
    `SELECT n.type, n.content, n.created_at, n.read_at, n.archived, f.name AS from_name
     FROM notifications n LEFT JOIN agents f ON f.id = n.from_agent_id
     WHERE n.agent_id = ? ORDER BY n.id`
  ).all(agentId);
  if (!inbox.length) parts.push("（无）\n");
  for (const x of inbox) {
    parts.push(`- [${x.type}] ${x.from_name || "匿名"} → ${fmt(x.created_at)}${x.read_at ? "" : "（未读）"}${x.archived ? "（已归档）" : ""}：${x.content || ""}`);
  }
  parts.push("\n---\n导出结束");

  return parts.join("\n");
}
