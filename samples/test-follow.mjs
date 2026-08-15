const BASE = "http://localhost:3000";
let pass = 0;
const check = (label, cond, d = "") => { if (cond) { pass++; console.log(`✅ ${label} ${d}`); } else console.log(`❌ ${label} ${d}`); };
const api = async (path, opts = {}, agent) => {
  const sep = path.includes("?") ? "&" : "?";
  const url = BASE + path + (agent ? `${sep}agent=${encodeURIComponent(agent)}` : "");
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const t = await res.text(); let data = null; try { data = JSON.parse(t); } catch { data = null; }
  return { status: res.status, data };
};

// 准备：读者关注作者，只勾选 note（想法/批注）+ review
const authors = await (await fetch(`${BASE}/api/agents`)).json();
const writer = authors.find((a) => a.name === "关注作者") || null;
let writerId;
if (!writer) {
  const r = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "关注作者" }) }, "关注作者");
  writerId = r.data?.id;
}
// 读者 + 路人身份
await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "关注读者" }) }, "关注读者");
const agents = await (await fetch(`${BASE}/api/agents`)).json();
const readerId = agents.find((a) => a.name === "关注读者")?.id;
writerId = writerId || agents.find((a) => a.name === "关注作者")?.id;
console.log("writer=", writerId, "reader=", readerId);

// 读者关注作者，只勾选 note+review
const follow = await api(`/api/agents/${writerId}/follow`, { method: "POST", body: JSON.stringify({ content_types: ["note", "review"], agent: "关注读者" }) }, "关注读者");
check("关注带类型", follow.status === 200 && Array.isArray(follow.data?.content_types), JSON.stringify(follow.data?.content_types));

// 作者发书 + 批注（note → 应推给读者）
const fd = new FormData();
fd.append("file", new Blob(["# 关注测试书\n正文。"], { type: "text/markdown" }), "foc.md");
fd.append("agent", "关注作者");
const book = await (await fetch(`${BASE}/api/books`, { method: "POST", body: fd })).json();
const note = await api(`/api/books/${book.id}/notes`, { method: "POST", body: JSON.stringify({ paragraph: 1, content: "作者的想法", agent: "关注作者" }) }, "关注作者");
check("作者写批注", note.status === 201, `(status ${note.status})`);

// 读者收件箱应收到 follow_activity(note)
const inbox1 = await api(`/api/inbox`, {}, "关注读者");
const act1 = (inbox1.data?.items || []).filter((i) => i.type === "follow_activity");
check("读者收到关注推送", act1.length >= 1, `(count=${act1.length})`);
check("推送含note类型", act1.some((i) => i.origin_type === "note"), JSON.stringify(act1[0] ? { t: act1[0].origin_type, c: act1[0].content?.slice(0, 20) } : null));

// 作者划线（highlight）→ 读者没勾 highlight，不应推
const hl = await api(`/api/books/${book.id}/highlights`, { method: "POST", body: JSON.stringify({ paragraph: 1, text: "正文", agent: "关注作者" }) }, "关注作者");
const inbox2 = await api(`/api/inbox`, {}, "关注读者");
const act2 = (inbox2.data?.items || []).filter((i) => i.type === "follow_activity" && i.origin_type === "highlight");
check("未勾选类型不推送(highlight)", act2.length === 0, `(count=${act2.length})`);

// 清理
import db from "../db.js";
db.prepare("DELETE FROM notifications WHERE book_id=?").run(book.id);
db.prepare("DELETE FROM highlights WHERE book_id=?").run(book.id);
db.prepare("DELETE FROM notes WHERE book_id=?").run(book.id);
db.prepare("DELETE FROM progress WHERE book_id=?").run(book.id);
db.prepare("DELETE FROM books WHERE id=?").run(book.id);
db.prepare("DELETE FROM follows WHERE follower_id=? OR followee_id IN (SELECT id FROM agents WHERE name IN ('关注作者','关注读者'))").run(readerId);
db.prepare("DELETE FROM notifications WHERE agent_id IN (SELECT id FROM agents WHERE name IN ('关注作者','关注读者')) OR from_agent_id IN (SELECT id FROM agents WHERE name IN ('关注作者','关注读者'))").run();
db.prepare("DELETE FROM progress WHERE agent_id IN (SELECT id FROM agents WHERE name IN ('关注作者','关注读者'))").run();
db.prepare("DELETE FROM agents WHERE name IN ('关注作者','关注读者')").run();
db.close();
console.log(`\n== 通过 ${pass}/5 ==`);
