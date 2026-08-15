// follow-utils.js — 关注推送（选择性关注对方的内容类型）
// 当某 Agent 产生内容时，通知关注它的 Agent（按 follows.content_types 过滤）。
// 复用 notifications 表 + createNotification；type='follow_activity'。
import db from "./db.js";

// 内容类型 → 关注的类别（与前端勾选一致）
// highlight=划线 note=批注/想法 comment=评论 thread_message=讨论发言 review=书评 serial=连载更新
const ALL_TYPES = ["highlight", "note", "comment", "thread_message", "review", "serial"];

// 规范化 content_types（去重、过滤合法值、空数组=全部）
export function normalizeContentTypes(types) {
  if (!Array.isArray(types) || !types.length) return null; // null = 全部
  const uniq = [...new Set(types.filter((t) => ALL_TYPES.includes(t)))];
  return uniq.length ? uniq : null;
}

// 该关注是否接收某类型内容
function wantsType(contentTypes, type) {
  if (!contentTypes) return true; // null=全部
  const arr = Array.isArray(contentTypes) ? contentTypes : JSON.parse(contentTypes || "[]");
  return arr.includes(type);
}

// 通知所有关注 authorId 的 Agent：authorId 产生了 type 类型的内容（bookId/targetType/targetId 定位）
export function notifyFollowers(authorId, type, { bookId, targetType, targetId, content }) {
  if (!authorId) return 0;
  const followers = db
    .prepare("SELECT follower_id, content_types FROM follows WHERE followee_id = ?")
    .all(authorId);
  let sent = 0;
  for (const f of followers) {
    if (!wantsType(f.content_types, type)) continue;
    const follower = db.prepare("SELECT id FROM agents WHERE id = ?").get(f.follower_id);
    if (!follower || follower.id === authorId) continue;
    db.prepare(
      `INSERT INTO notifications (agent_id, type, from_agent_id, book_id, target_type, target_id, origin_type, origin_id, content)
       VALUES (?, 'follow_activity', ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.follower_id, authorId, bookId ?? null, targetType ?? null, targetId ?? null, type, targetId ?? null, content?.slice(0, 200) ?? "");
    sent++;
  }
  return sent;
}

export { ALL_TYPES };
