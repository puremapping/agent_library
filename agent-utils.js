import db from "./db.js";
import { createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const testHash = scryptSync(String(password), salt, 64);
  const storedHash = Buffer.from(hash, "hex");
  return storedHash.length === testHash.length && timingSafeEqual(storedHash, testHash);
}

// 脱敏：返回给客户端的 agent 不含 password，带 has_password / is_admin 标记（email 保留，用于联系）
function sanitize(agent) {
  if (!agent) return null;
  const { password, ...rest } = agent;
  return { ...rest, has_password: !!password, is_admin: !!agent.is_admin };
}

export function isAdmin(agent) {
  return !!(agent && agent.is_admin);
}

export function getOrCreateAgent(name, password, email) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(clean);
  if (existing) {
    // 已有身份：若新提供邮箱且原为空，补上
    if (email && !existing.email) {
      db.prepare("UPDATE agents SET email = ? WHERE id = ?").run(email.trim(), existing.id);
      return sanitize(db.prepare("SELECT * FROM agents WHERE id = ?").get(existing.id));
    }
    return sanitize(existing);
  }
  const pw = password ? hashPassword(password) : null;
  const info = db.prepare("INSERT INTO agents (name, password, email) VALUES (?, ?, ?)").run(clean, pw, email ? email.trim() : null);
  return sanitize(db.prepare("SELECT * FROM agents WHERE id = ?").get(info.lastInsertRowid));
}

// 仅查名字是否已被占用（不创建）。用于注册端点做"名字已存在"校验。
export function agentExists(name) {
  const clean = String(name || "").trim();
  if (!clean) return false;
  return !!db.prepare("SELECT id FROM agents WHERE name = ?").get(clean);
}

// 登录：名字+密码 → 成功返回脱敏 agent，失败返回 { error }
export function loginAgent(name, password) {
  const clean = String(name || "").trim();
  if (!clean || !password) return { error: "名字和密码必填" };
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(clean);
  if (!agent) return { error: "身份不存在，请先注册" };
  if (!agent.password) return { error: "该身份未设密码（是 Agent 身份），不能通过密码登录" };
  if (!verifyPassword(password, agent.password)) return { error: "密码错误" };
  return sanitize(agent);
}

export function renameAgent(id, newName) {
  const clean = String(newName || "").trim();
  if (!clean) return { error: "名字不能为空" };
  if (agentExists(clean)) return { error: "名字已存在" };
  const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id);
  if (!agent) return { error: "Agent 不存在" };
  db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(clean, id);
  return sanitize(db.prepare("SELECT id, name, password FROM agents WHERE id = ?").get(id));
}

export function getAgent(id) {
  return sanitize(db.prepare("SELECT * FROM agents WHERE id = ?").get(id));
}

export function listAgents() {
  return db.prepare("SELECT id, name, password, is_admin, created_at FROM agents ORDER BY id").all().map((a) => {
    const { password, ...rest } = a;
    return { ...rest, has_password: !!password, is_admin: !!a.is_admin };
  });
}

export function resolveAgent(req) {
  const name = req.get("X-Agent-Name") || req.query.agent || req.body?.agent;
  return getOrCreateAgent(name);
}
