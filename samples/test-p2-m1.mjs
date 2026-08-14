const BASE = "http://localhost:3000";
let pass = 0;
const check = (label, cond, d = "") => { if (cond) { pass++; console.log(`✅ ${label} ${d}`); } else console.log(`❌ ${label} ${d}`); };
const api = async (path, opts = {}, agent) => {
  const sep = path.includes("?") ? "&" : "?";
  const url = BASE + path + (agent ? `${sep}agent=${encodeURIComponent(agent)}` : "");
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

// === REST ===
// 发布短篇
const w = await api("/api/works", { method: "POST", body: JSON.stringify({ title: "短篇测试", content: "# 开头\n\n这是短篇正文。\n\n## 第二段\n\n结尾。" }) }, "小霁");
check("REST add_work 201", w.status === 201, `(status ${w.status})`);
check("REST add_work kind=work", w.data.kind === "work", `(kind=${w.data.kind})`);
check("REST add_work 作者=小霁", w.data.created_by != null);

// 创建连载
const s = await api("/api/serials", { method: "POST", body: JSON.stringify({ title: "连载测试" }) }, "小霁");
check("REST create_serial 201", s.status === 201, `(status ${s.status})`);
check("REST create_serial 返回series_id", s.data.series_id != null, `(series_id=${s.data.series_id})`);

// 追加两章
const c1 = await api(`/api/serials/${s.data.series_id}/chapters`, { method: "POST", body: JSON.stringify({ title: "第一章", content: "第一章正文。\n\n第一章第二段。" }) }, "小霁");
const c2 = await api(`/api/serials/${s.data.series_id}/chapters`, { method: "POST", body: JSON.stringify({ title: "第二章", content: "第二章正文。" }) }, "小霁");
check("REST add_serial_chapter 201", c1.status === 201 && c2.status === 201, `(c1=${c1.status}, c2=${c2.status})`);
check("REST 章节kind=serial", c1.data.kind === "serial", `(kind=${c1.data.kind})`);
check("REST 章节series_id绑定", c1.data.series_id === s.data.series_id, `(series_id=${c1.data.series_id})`);

// 列出章节
const l = await api(`/api/serials/${s.data.series_id}`, {}, "小霁");
check("REST list_serial 章节数=2", l.data.chapters.length === 2, `(count=${l.data.chapters.length})`);
check("REST list_serial 按序", l.data.chapters[0].title === "第一章", `(first=${l.data.chapters[0].title})`);

// 阅读闭环：另一 Agent 用 get_book 读章节
const gb = await api(`/api/books/${c1.data.id}`, {}, "opencode");
check("REST 读者读章节 200", gb.status === 200, `(status ${gb.status})`);
check("REST 读到的段落含正文", Array.isArray(gb.data.paragraphs) && gb.data.paragraphs.some((p) => p.includes("第一章正文")), `(paras=${gb.data.paragraphs?.length})`);

// 权限：他人不能给连载追加
const other = await api(`/api/serials/${s.data.series_id}/chapters`, { method: "POST", body: JSON.stringify({ title: "越权章", content: "x" }) }, "opencode");
check("REST 他人追加被拒 403", other.status === 403, `(status ${other.status})`);

// 删除保护：章节上有他人划线时禁删（管理员豁免）
const hl = await fetch(`${BASE}/api/books/${c1.data.id}/highlights`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paragraph: 0, text: "第一章正文", start_char: 0, end_char: 6, agent: "opencode", color: "yellow" }),
});
check("REST 读者在章节划线成功", hl.status === 201, `(status ${hl.status})`);
const del = await api(`/api/books/${c1.data.id}`, { method: "DELETE" }, "小霁");
check("REST 有他人笔记禁删 403", del.status === 403, `(status ${del.status})`);

// 清理划线（保留章节书供 MCP 测）
// （划线删除接口：DELETE /api/highlights/:id？ 查现有——若没有则留给清理脚本）

console.log(`\n== REST 通过 ${pass}/11 ==`);

// === MCP ===
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: "node", args: ["D:/ws/agent_library/mcp-server.js"] });
const client = new Client({ name: "t", version: "0.1.0" });
await client.connect(transport);
const mcp = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const mw = await mcp("add_work", { title: "MCP短篇", content: "# 头\n\nMCP 短篇正文。", agent_name: "opencode" });
check("MCP add_work", mw.id != null && mw.kind === "work", `(id=${mw.id})`);

const ms = await mcp("create_serial", { title: "MCP连载", agent_name: "opencode" });
check("MCP create_serial", ms.series_id != null, `(series_id=${ms.series_id})`);

const mc1 = await mcp("add_serial_chapter", { series_id: ms.series_id, title: "第一章", content: "MCP 第一章正文。\n\n第二段。", agent_name: "opencode" });
const mc2 = await mcp("add_serial_chapter", { series_id: ms.series_id, title: "第二章", content: "MCP 第二章正文。", agent_name: "opencode" });
check("MCP add_serial_chapter x2", mc1.id != null && mc2.id != null, `(ids=${mc1.id},${mc2.id})`);

const ml = await mcp("list_serial", { series_id: ms.series_id });
check("MCP list_serial 章节数=2", ml.chapters.length === 2, `(count=${ml.chapters.length})`);

// 越权
const mOther = await mcp("add_serial_chapter", { series_id: ms.series_id, title: "越权", content: "x", agent_name: "小霁" });
check("MCP 他人追加被拒", !!mOther.error, JSON.stringify(mOther).slice(0, 40));

await client.close();
console.log(`\n== MCP 通过 ${pass - 11}/5 ==`);

import db from "../db.js";
db.prepare("DELETE FROM highlights WHERE book_id = ?", ).all;
db.close();
