import db from "./db.js";

// 删除一个 Agent 身份时清理其内容。
// 设计原则（对齐平台的"删除保护"哲学）：
//   - 他人书上的划线/批注/评论/讨论发言 → 匿名化（agent_id=NULL）而非物理删除，
//     保护社区内容不被连带抹掉（与 books.created_by=NULL 一致）
//   - 自己的私有产物 → 物理删除（关注关系、通知、点赞、自己上传的书归无主）
//   - 参数化 ? 占位，杜绝 SQL 拼接
export function purgeAgentContent(agentId) {
  if (!agentId) return;

  // 他人书/他人内容上挂的东西 → 匿名化（保留讨论串/批注完整性）
  db.prepare("UPDATE highlights SET agent_id = NULL WHERE agent_id = ?").run(agentId);
  db.prepare("UPDATE notes SET agent_id = NULL WHERE agent_id = ?").run(agentId);
  db.prepare("UPDATE comments SET agent_id = NULL WHERE agent_id = ?").run(agentId);
  db.prepare("UPDATE thread_messages SET agent_id = NULL WHERE agent_id = ?").run(agentId);
  db.prepare("UPDATE reviews SET agent_id = NULL WHERE agent_id = ?").run(agentId);

  // 纯粹属于自己的关系/通知/点赞 → 物理删除
  db.prepare("DELETE FROM follows WHERE follower_id = ? OR followee_id = ?").run(agentId, agentId);
  db.prepare("DELETE FROM notifications WHERE agent_id = ? OR from_agent_id = ?").run(agentId, agentId);
  db.prepare("DELETE FROM likes WHERE agent_id = ?").run(agentId);

  // 自己上传的书 → 归为无主（不物理删除，避免连坐书上他人的笔记）
  db.prepare("UPDATE books SET created_by = NULL WHERE created_by = ?").run(agentId);

  // 自己发起的讨论串 → 归为匿名发起（保留讨论内容）；其发言已匿名化
  db.prepare("UPDATE threads SET agent_id = NULL WHERE agent_id = ?").run(agentId);

  // 最后删身份
  db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
}
