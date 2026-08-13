import db from "./db.js";

export function getOrCreateAgent(name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(clean);
  if (existing) return existing;
  const info = db.prepare("INSERT INTO agents (name) VALUES (?)").run(clean);
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(info.lastInsertRowid);
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
