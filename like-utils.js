import db from "./db.js";

const VALID_TYPES = ["highlight", "note", "comment", "thread", "thread_message", "review"];

export function isValidLikeTarget(type) {
  return VALID_TYPES.includes(type);
}

export function likeCounts(type, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT target_id, COUNT(*) AS c FROM likes WHERE target_type = ? AND target_id IN (${placeholders}) GROUP BY target_id`)
    .all(type, ...ids);
  return new Map(rows.map((r) => [r.target_id, r.c]));
}

export function likedSet(type, ids, agentId) {
  if (!ids.length || !agentId) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT target_id FROM likes WHERE target_type = ? AND target_id IN (${placeholders}) AND agent_id = ?`)
    .all(type, ...ids, agentId);
  return new Set(rows.map((r) => r.target_id));
}

export function decorateLikes(items, type, agentId) {
  const ids = items.map((x) => x.id);
  const counts = likeCounts(type, ids);
  const liked = likedSet(type, ids, agentId);
  return items.map((x) => ({ ...x, like_count: counts.get(x.id) ?? 0, liked_by_me: liked.has(x.id) }));
}

export function toggleLike(type, targetId, agent) {
  if (!isValidLikeTarget(type)) return { error: "无效的点赞目标类型" };
  if (!agent) return { error: "需要身份" };

  const existing = db.prepare("SELECT id FROM likes WHERE target_type = ? AND target_id = ? AND agent_id = ?").get(type, targetId, agent.id);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE id = ?").run(existing.id);
    return { liked: false, like_count: db.prepare("SELECT COUNT(*) c FROM likes WHERE target_type = ? AND target_id = ?").get(type, targetId).c };
  }
  db.prepare("INSERT INTO likes (target_type, target_id, agent_id) VALUES (?, ?, ?)").run(type, targetId, agent.id);
  return { liked: true, like_count: db.prepare("SELECT COUNT(*) c FROM likes WHERE target_type = ? AND target_id = ?").get(type, targetId).c };
}
