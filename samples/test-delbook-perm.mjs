const BASE = "http://localhost:3000";
const api = async (method, path, { body, agent } = {}) => {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  let url = BASE + path;
  if (agent && !body) url += (url.includes("?") ? "&" : "?") + "agent=" + encodeURIComponent(agent);
  if (agent && body) body = { ...body, agent };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};
let pass = 0;
const check = (label, cond, d = "") => { if (cond) { pass++; console.log(`✅ ${label} ${d}`); } else console.log(`❌ ${label} ${d}`); };

// 造两个测试用户
await api("POST", "/api/agents", { body: { name: "删书甲" } });
await api("POST", "/api/agents", { body: { name: "删书乙" } });

// 甲上传一本书（带 created_by）
const fd = new FormData();
fd.append("file", new Blob(["# 甲的书\n内容。"], { type: "text/markdown" }), "甲的书.md");
fd.append("agent", "删书甲");
const upRes = await fetch(`${BASE}/api/books`, { method: "POST", body: fd });
const upBook = await upRes.json();
check("甲上传书", upRes.status === 201, `(id=${upBook.id})`);
const bookId = upBook.id;

// 乙删甲的书 → 403
let r = await api("DELETE", `/api/books/${bookId}`, { agent: "删书乙" });
check("乙不能删甲的书", r.status === 403, `(status ${r.status})`);

// 无身份删 → 403（book 有 owner）
r = await api("DELETE", `/api/books/${bookId}`);
check("无身份不能删", r.status === 403, `(status ${r.status})`);

// 甲删自己的书 → 200
r = await api("DELETE", `/api/books/${bookId}`, { agent: "删书甲" });
check("甲删自己的书", r.status === 200 && r.data.ok === true, `(status ${r.status})`);

// 无主书（created_by null）：书5是历史数据无owner，任何带身份者可删——但不删它，改用造一本无主书
const fd2 = new FormData();
fd2.append("file", new Blob(["# 无主书\n内容。"], { type: "text/markdown" }), "无主书.md");
const upRes2 = await fetch(`${BASE}/api/books`, { method: "POST", body: fd2 });
const orphanBook = await upRes2.json();
// 把 created_by 置空模拟无主书
import db from "../db.js";
db.prepare("UPDATE books SET created_by = NULL WHERE id = ?").run(orphanBook.id);
r = await api("DELETE", `/api/books/${orphanBook.id}`, { agent: "删书乙" });
check("无主书任何带身份者可删", r.status === 200, `(status ${r.status})`);

// MCP: 乙删甲的书 → 拒绝
await api("POST", "/api/agents", { body: { name: "删书丙" } });
const fd3 = new FormData();
fd3.append("file", new Blob(["# 丙的书\n内容。"], { type: "text/markdown" }), "丙的书.md");
fd3.append("agent", "删书丙");
const upRes3 = await fetch(`${BASE}/api/books`, { method: "POST", body: fd3 });
const cBook = await upRes3.json();
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: "node", args: ["D:/ws/agent_library/mcp-server.js"] });
const client = new Client({ name: "t", version: "0.1.0" });
await client.connect(transport);
const mcp = async (args) => JSON.parse((await client.callTool({ name: "delete_book", arguments: args })).content[0].text);
let mr = await mcp({ book_id: cBook.id, agent_name: "删书乙" });
check("MCP 乙不能删丙的书", mr.error && mr.error.includes("自己上传"), JSON.stringify(mr));
mr = await mcp({ book_id: cBook.id, agent_name: "删书丙" });
check("MCP 丙删自己的书", mr.ok === true, JSON.stringify(mr));
await client.close();

// 清理测试身份
db.exec("DELETE FROM agents WHERE name IN ('删书甲','删书乙','删书丙')");
db.close();
console.log(`\n== 通过 ${pass}/7 ==`);
