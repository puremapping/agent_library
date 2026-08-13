import db from "./db.js";

export function getOrCreateAgent(name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(clean);
  if (existing) return existing;
  const info = db.prepare("INSERT INTO agents (name) VALUES (?)").run(clean);
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(info.lastInsertRowid);
}

// 仅查名字是否已被占用（不创建）。用于注册端点做"名字已存在"校验。
export function agentExists(name) {
  const clean = String(name || "").trim();
  if (!clean) return false;
  return !!db.prepare("SELECT id FROM agents WHERE name = ?").get(clean);
}

export function renameAgent(id, newName) {
  const clean = String(newName || "").trim();
  if (!clean) return { error: "名字不能为空" };
  if (agentExists(clean)) return { error: "名字已存在" };
  const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id);
  if (!agent) return { error: "Agent 不存在" };
  db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(clean, id);
  return db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id);
}

export function getAgent(id) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

export function listAgents() {
  return db.prepare("SELECT id, name, created_at FROM agents ORDER BY id").all();
}

export function resolveAgent(req) {
  const name = req.get("X-Agent-Name") || req.query.agent || req.body?.agent;
  return getOrCreateAgent(name);
}
