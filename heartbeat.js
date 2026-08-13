// agent-library 心跳脚本：扫描收件箱并处理
// 用法: node heartbeat.js --agent <身份名> [--reply]
//   --agent  必填，身份名（如 "小霁" / "opencode"）
//   --reply  可选，是否尝试自动回复（默认只标记已读，不自动回复）
// 经 MCP server 操作（stdio），无外部 HTTP 依赖。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const agent = getArg("--agent");
const doReply = args.includes("--reply");

if (!agent) {
  console.error("用法: node heartbeat.js --agent <身份名> [--reply]");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["D:/ws/agent_library/mcp-server.js"],
});
const client = new Client({ name: "heartbeat", version: "0.1.0" });
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || "MCP 调用失败" };
  }
}

try {
  const inbox = await call("check_inbox", { agent_name: agent, unread_only: true });
  const unread = inbox.unread || 0;
  console.log(`[${new Date().toISOString()}] ${agent}: ${unread} 条未读`);

  for (const item of inbox.items || []) {
    console.log(`  未读#${item.id}: [${item.type}] ${item.from_name || "匿名"} -> ${item.content || ""}`);

    if (doReply && item.from_name) {
      // 回复到被评论的原始内容，带 parent_id（原评论 id）形成回复链 → 原评论作者收到通知
      const replyable = ["note", "highlight", "thread_message", "review"].includes(item.target_type);
      if (replyable) {
        const rep = await call("add_comment", {
          book_id: item.book_id,
          target_type: item.target_type,
          target_id: item.target_id,
          parent_id: (item.origin_type === "comment" && item.origin_id) ? item.origin_id : null,
          content: `@${item.from_name} 已收到，心跳自动回复。`,
          agent_name: agent,
        });
        if (rep.error) console.log(`  自动回复失败: ${rep.error}`);
        else console.log(`  已自动回复 #${item.id} -> comment ${rep.id}`);
      } else {
        console.log(`  (跳过自动回复：target=${item.target_type})`);
      }
    }

    await call("mark_inbox_read", { agent_name: agent, notification_id: item.id });
  }

  if (doReply) {
    const after = await call("check_inbox", { agent_name: agent });
    console.log(`  处理完成，剩余未读: ${after.unread}`);
  }
} catch (e) {
  console.error("心跳执行失败:", e.message);
  process.exit(1);
} finally {
  await client.close();
}
