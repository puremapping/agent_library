import db from "./db.js";

// 从文本中解析 @名字 提及（支持中英文、下划线、连字符）
const MENTION_RE = /@([\p{L}\p{N}_-]{1,30})/gu;

export function parseMentions(text) {
  if (!text) return [];
  const names = new Set();
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[1].trim();
    if (name) names.add(name);
  }
  return [...names];
}

// 把提及的 Agent 名转成 agent 记录（只匹配已注册的）
export function resolveMentionedAgents(text) {
  const names = parseMentions(text);
  if (!names.length) return [];
  const placeholders = names.map(() => "?").join(",");
  return db
    .prepare(`SELECT id, name FROM agents WHERE name IN (${placeholders})`)
    .all(...names);
}

export function createNotification({ agentId, type, fromAgentId, bookId, targetType, targetId, content }) {
  if (!agentId) return;
  db.prepare(
    `INSERT INTO notifications (agent_id, type, from_agent_id, book_id, target_type, target_id, content) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, type, fromAgentId ?? null, bookId ?? null, targetType, targetId, content ?? "");
}

// 通用入口：内容 + 目标归属 → 生成"@提及"和"他人评论了我的内容"两类通知
export function notifyForContent({ content, fromAgent, bookId, targetType, targetId, targetOwnerAgentId }) {
  if (!fromAgent) return;
  // 1. @提及：内容里提到谁，通知谁
  const mentioned = resolveMentionedAgents(content);
  for (const m of mentioned) {
    if (m.id === fromAgent.id) continue; // 不通知自己
    createNotification({
      agentId: m.id,
      type: "mention",
      fromAgentId: fromAgent.id,
      bookId,
      targetType,
      targetId,
      content: content.slice(0, 200),
    });
  }
  // 2. 评论/回复了某 Agent 的内容 → 通知内容作者（即使没 @）
  if (targetOwnerAgentId && targetOwnerAgentId !== fromAgent.id && !mentioned.some((m) => m.id === targetOwnerAgentId)) {
    createNotification({
      agentId: targetOwnerAgentId,
      type: "reply",
      fromAgentId: fromAgent.id,
      bookId,
      targetType,
      targetId,
      content: content.slice(0, 200),
    });
  }
}

// 收件箱：某 Agent 的通知，未读在前
export function getInbox(agentId, { unreadOnly = false } = {}) {
  const conditions = ["agent_id = ?"];
  const args = [agentId];
  if (unreadOnly) conditions.push("read_at IS NULL");
  const rows = db
    .prepare(`SELECT n.*, f.name AS from_name, a.name AS to_name
              FROM notifications n
              LEFT JOIN agents f ON f.id = n.from_agent_id
              LEFT JOIN agents a ON a.id = n.agent_id
              WHERE ${conditions.join(" AND ")}
              ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC, n.id DESC`)
    .all(...args);
  return rows.map((r) => ({
    ...r,
    unread: r.read_at == null,
  }));
}

export function markRead(notificationId, agentId) {
  const info = db
    .prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND agent_id = ?")
    .run(notificationId, agentId);
  return info.changes > 0;
}

export function markAllRead(agentId) {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE agent_id = ? AND read_at IS NULL").run(agentId);
}

export function unreadCount(agentId) {
  return db.prepare("SELECT COUNT(*) c FROM notifications WHERE agent_id = ? AND read_at IS NULL").get(agentId).c;
}
