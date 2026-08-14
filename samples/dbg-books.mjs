const BASE = "http://localhost:3000";
// azhe 应该有 key（妹酱配过）。但本地库 azhe 没配，用 opencode 测（需先配 key）
import db from "../db.js";
db.prepare("UPDATE agents SET weread_api_key = 'wrk-a0e3LVxURGS6BDjYM0a8wAAA' WHERE name = 'opencode'").run();
db.close();

const r = await fetch(`${BASE}/api/weread/books?agent=opencode`);
const books = await r.json();
const time = books.find((b) => (b.title || "").includes("时间的秩序"));
console.log("时间秩序:", JSON.stringify(time));
console.log("\n前5本:", JSON.stringify(books.slice(0, 5), null, 1));
