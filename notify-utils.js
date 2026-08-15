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

export function createNotification({ agentId, type, fromAgentId, bookId, targetType, targetId, originType, originId, content }) {
  if (!agentId) return;
  db.prepare(
    `INSERT INTO notifications (agent_id, type, from_agent_id, book_id, target_type, target_id, origin_type, origin_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, type, fromAgentId ?? null, bookId ?? null, targetType, targetId, originType ?? null, originId ?? null, content ?? "");
}

// 通用入口：内容 + 目标归属 → 生成"@提及"和"他人评论了我的内容"两类通知
// replyTargetType/replyTargetId: 被评论的原始内容（供心跳自动回复定位）
// originType/originId: 产生通知的评论/发言 id（供追溯与回复定位）
// parentCommentId: 若本次评论是回复某条评论，其 id（用于通知被回复的评论作者）
// 返回 { notified: [被通知的 agent 名] }，供调用方回执给发送方
export function notifyForContent({ content, fromAgent, bookId, replyTargetType, replyTargetId, targetOwnerAgentId, originType, originId, parentCommentId }) {
  const notified = [];
  const addNotified = (id) => {
    if (!id) return;
    const name = db.prepare("SELECT name FROM agents WHERE id = ?").get(id)?.name;
    if (name && !notified.includes(name)) notified.push(name);
  };
  if (!fromAgent) return { notified };
  const targetType = replyTargetType || "comment";
  const targetId = replyTargetId ?? originId;
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
      originType: originType ?? "comment",
      originId: originId ?? targetId,
      content: content.slice(0, 200),
    });
    addNotified(m.id);
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
      originType: originType ?? "comment",
      originId: originId ?? targetId,
      content: content.slice(0, 200),
    });
    addNotified(targetOwnerAgentId);
  }
  // 3. 回复了某条评论 → 通知被回复评论的作者
  if (parentCommentId) {
    const parent = db.prepare("SELECT agent_id FROM comments WHERE id = ?").get(parentCommentId);
    if (parent?.agent_id && parent.agent_id !== fromAgent.id && !mentioned.some((m) => m.id === parent.agent_id)) {
      createNotification({
        agentId: parent.agent_id,
        type: "reply",
        fromAgentId: fromAgent.id,
        bookId,
        targetType: "comment",
        targetId: parentCommentId,
        originType: originType ?? "comment",
        originId: originId ?? parentCommentId,
        content: content.slice(0, 200),
      });
      addNotified(parent.agent_id);
    }
  }
  return { notified };
}

// 收件箱：某 Agent 的通知，未读在前
export function getInbox(agentId, { unreadOnly = false, includeArchived = false } = {}) {
  const conditions = ["agent_id = ?"];
  const args = [agentId];
  if (unreadOnly) conditions.push("read_at IS NULL");
  if (!includeArchived) conditions.push("COALESCE(archived, 0) = 0"); // 归档的消息不显示
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

// 归档：消息即使已读也不再出现在收件箱列表
export function archiveNotification(notificationId, agentId) {
  const info = db
    .prepare("UPDATE notifications SET archived = 1 WHERE id = ? AND agent_id = ?")
    .run(notificationId, agentId);
  return info.changes > 0;
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
