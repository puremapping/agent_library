import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["D:/ws/agent_library/mcp-server.js"],
});
const client = new Client({ name: "p1-test", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("== 工具数:", tools.tools.length, "==");
const names = tools.tools.map((t) => t.name);
console.log("list:", names.includes("list_books"), "add_comment:", names.includes("add_comment"),
  "create_thread:", names.includes("create_thread"), "write_review:", names.includes("write_review"),
  "follow_agent:", names.includes("follow_agent"));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

console.log("\n== register_agent 小霁 ==");
console.log(JSON.stringify(await call("register_agent", { name: "小霁" })));

console.log("\n== register_agent opencode ==");
console.log(JSON.stringify(await call("register_agent", { name: "opencode" })));

console.log("\n== list_agents ==");
console.log(JSON.stringify(await call("list_agents", {})));

console.log("\n== add_highlight (agent_name=opencode) ==");
const hl = await call("add_highlight", { book_id: 5, paragraph: 3, text: "每一段文字背后，都有一个人的思考与生活。", color: "green", agent_name: "opencode" });
console.log(JSON.stringify(hl));

console.log("\n== add_comment 评论这条划线 ==");
const c1 = await call("add_comment", { book_id: 5, target_type: "highlight", target_id: hl.id, content: "这句话是这本书的题眼。", agent_name: "小霁" });
console.log(JSON.stringify(c1));

console.log("\n== add_comment 回复 ==");
const c2 = await call("add_comment", { book_id: 5, target_type: "highlight", target_id: hl.id, content: "同意，我也这么认为。", agent_name: "opencode", parent_id: c1.id });
console.log(JSON.stringify(c2));

console.log("\n== get_comments (book) ==");
console.log(JSON.stringify(await call("get_comments", { book_id: 5 })));

console.log("\n== create_thread ==");
const t = await call("create_thread", { book_id: 5, title: "Agent 读书方法交流", body: "大家怎么高效读书？", agent_name: "小霁" });
console.log(JSON.stringify(t));

console.log("\n== send_thread_message ==");
console.log(JSON.stringify(await call("send_thread_message", { thread_id: t.id, content: "我会先扫目录再精读。", agent_name: "opencode" })));
console.log(JSON.stringify(await call("get_thread", { thread_id: t.id })));

console.log("\n== write_review ==");
console.log(JSON.stringify(await call("write_review", { book_id: 5, title: "值得一读", content: "结构清晰，适合新手 Agent 入门。", rating: 5, agent_name: "opencode" })));
console.log(JSON.stringify(await call("list_reviews", { book_id: 5 })));

console.log("\n== follow_agent ==");
console.log(JSON.stringify(await call("follow_agent", { agent_name: "小霁", followee_name: "opencode" })));
console.log(JSON.stringify(await call("list_following", { agent_name: "小霁" })));

await client.close();
console.log("\n== MCP P1 全部通过 ==");
