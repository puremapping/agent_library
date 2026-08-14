// weread-lib.js — 微信读书同步核心逻辑（共享模块）
// 供 weread-sync.js（CLI）与 server.js（REST/网页）共用，保证行为一致。
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 环境变量（可配，服务器/本机通用）
export const WEREAD_KEY = process.env.WEREAD_API_KEY;
export const AL_BASE = process.env.AL_BASE || "http://localhost:3000";
export const AL_AGENT = process.env.AL_AGENT || "human";
export const PANDOC = process.env.PANDOC_PATH || "D:/fs/70_Software/pandoc/pandoc.exe";
export const EBOOK_CONVERT = process.env.EBOOK_CONVERT_PATH || "D:/fs/70_Software/calibre/ebook-convert.exe";
export const EBOOKS_DIR = process.env.EBOOKS_DIR || path.join(import.meta.dirname, "ebooks");
const SKILL_VER = "1.0.4";
const STATE_FILE = path.join(import.meta.dirname, ".weread-state.json");

// ---------- 微信读书网关 ----------
export async function weread(apiName, params = {}) {
  if (!WEREAD_KEY) throw new Error("需要 WEREAD_API_KEY 环境变量（wrk- 开头）");
  const res = await fetch("https://i.weread.qq.com/api/agent/gateway", {
    method: "POST",
    headers: { Authorization: `Bearer ${WEREAD_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VER }),
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`weread ${apiName} 错误: ${data.errcode} ${data.msg || ""}`);
  return data;
}

// 全量笔记本（游标翻页）
export async function listNotebooks() {
  const all = [];
  let lastSort;
  let hasMore = 1;
  while (hasMore) {
    const page = await weread("/user/notebooks", lastSort ? { count: 50, lastSort } : { count: 50 });
    all.push(...(page.books || []));
    hasMore = page.hasMore;
    lastSort = page.books?.length ? page.books[page.books.length - 1].sort : undefined;
    if (!hasMore) break;
  }
  return all;
}

// 拉一本书的笔记（划线 + 想法）
export async function fetchNotes(bookId) {
  const [bm, rv] = await Promise.all([
    weread("/book/bookmarklist", { bookId }),
    weread("/review/list/mine", { bookid: bookId, synckey: 0, count: 200 }),
  ]);
  return {
    underlines: (bm.updated || []).map((u) => ({
      sourceId: u.bookmarkId, markText: u.markText, range: u.range,
      chapterUid: u.chapterUid, createTime: u.createTime, colorStyle: u.colorStyle,
    })),
    reviews: (rv.reviews || []).map((r) => ({
      sourceId: r.review?.reviewId, content: r.review?.content, abstract: r.review?.abstract,
      range: r.review?.range, chapterUid: r.review?.chapterUid, star: r.review?.star,
      createTime: r.review?.createTime,
    })),
    chapters: bm.chapters || [],
  };
}

// ---------- 转 md ----------
// epub/mobi → md：epub 用 pandoc，mobi 用 calibre ebook-convert（先转 txt）
export function convertToMd(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mobi" || ext === ".azw3") {
    const out = path.join(path.dirname(filePath), `_tmp_${Date.now()}.txt`);
    execSync(`"${EBOOK_CONVERT}" "${filePath}" "${out}"`, { stdio: "pipe", timeout: 300000 });
    const txt = fs.readFileSync(out, "utf8");
    fs.unlinkSync(out);
    return txt;
  }
  const tmp = path.join(path.dirname(filePath), `_tmp_${Date.now()}.md`);
  execSync(`"${PANDOC}" "${filePath}" -t gfm -o "${tmp}"`, { stdio: "pipe" });
  const md = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  return md;
}

// ---------- 锚定 ----------
export function normalize(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "")
    .replace(/\s+/g, "")
    .replace(/[\u201c\u201d""]/g, '"').replace(/[\u2018\u2019'']/g, "'")
    .replace(/[\u3000\u00a0]/g, "");
}

// 段落化文本（与 AL 的 splitParagraphs 一致：非空行 trim）
export function toParagraphs(content) {
  return String(content || "").split(/\r?\n/).filter((p) => p.trim().length > 0).map((p) => p.trim());
}

// 锚定：单段优先，全文拼接兜底（支持跨段），返回 {paragraph, start_char, end_char}
export function anchorInParagraph(paragraphs, markText) {
  const n = normalize(markText);
  if (!n) return null;
  for (let i = 0; i < paragraphs.length; i++) {
    const pn = normalize(paragraphs[i]);
    const idx = pn.indexOf(n);
    if (idx >= 0) return { paragraph: i, start_char: idx, end_char: idx + n.length };
  }
  const full = [];
  const paraOf = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const pn = normalize(paragraphs[i]);
    for (let j = 0; j < pn.length; j++) { full.push(pn[j]); paraOf.push(i); }
  }
  const fullStr = full.join("");
  const idx = fullStr.indexOf(n);
  if (idx < 0) return null;
  const startPara = paraOf[idx];
  let acc = 0;
  for (let i = 0; i < startPara; i++) acc += normalize(paragraphs[i]).length;
  const segStart = idx - acc;
  const paraLen = normalize(paragraphs[startPara]).length;
  const end = Math.min(segStart + n.length, paraLen);
  if (end <= segStart) return null;
  return { paragraph: startPara, start_char: segStart, end_char: end };
}

// 锚定率（全量，用于门槛判断）
export function anchorRate(paragraphs, notes) {
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  let hit = 0;
  for (const s of samples) if (anchorInParagraph(paragraphs, s.markText)) hit++;
  const total = samples.length;
  return { hit, total, rate: total ? Math.round((hit / total) * 100) : 0 };
}

// ---------- 本地找书 ----------
// 用书名前 3 字匹配（本地文件名可能与微信书名中间不同，如"我与你([德]...)" vs "我与你（果麦经典）"）
// 递归扫描 EBOOKS_DIR（含子目录，如"补充样例/同版"）
function scanBooks(dir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) out.push(...scanBooks(full));
      else if (/\.(epub|mobi|azw3)$/i.test(f)) out.push(full);
    }
  } catch {}
  return out;
}

export function findLocalBook(title) {
  if (!fs.existsSync(EBOOKS_DIR)) return null;
  const candidates = scanBooks(EBOOKS_DIR);
  const strip = (s) => String(s).replace(/[\s[\]【】()（）·,，.:：=~"'“”]+/g, "");
  const key = strip(title || "").slice(0, 3);
  const guess = candidates.find((f) => strip(f).includes(key));
  if (!guess) return null;
  return { path: guess, md: convertToMd(guess) };
}

// ---------- 增量同步状态 ----------
export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
export function lastSyncOf(state, bookId) {
  const t = state[bookId]?.lastSync;
  return typeof t === "number" ? t : 0;
}
