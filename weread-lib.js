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
// key 参数可选：per-user key（服务器按请求者取）；缺省用环境变量 WEREAD_API_KEY（管理员/CLI 用）
export async function weread(apiName, params = {}, key) {
  const useKey = key || WEREAD_KEY;
  if (!useKey) throw new Error("需要微信读书 API key（WEREAD_API_KEY 或用户已配置）");
  const res = await fetch("https://i.weread.qq.com/api/agent/gateway", {
    method: "POST",
    headers: { Authorization: `Bearer ${useKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VER }),
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`weread ${apiName} 错误: ${data.errcode} ${data.msg || ""}`);
  return data;
}

// 全量笔记本（游标翻页）
export async function listNotebooks(key) {
  const all = [];
  let lastSort;
  let hasMore = 1;
  while (hasMore) {
    const page = await weread("/user/notebooks", lastSort ? { count: 50, lastSort } : { count: 50 }, key);
    all.push(...(page.books || []));
    hasMore = page.hasMore;
    lastSort = page.books?.length ? page.books[page.books.length - 1].sort : undefined;
    if (!hasMore) break;
  }
  return all;
}

// 拉一本书的笔记（划线 + 想法）
export async function fetchNotes(bookId, key) {
  const [bm, rv] = await Promise.all([
    weread("/book/bookmarklist", { bookId }, key),
    weread("/review/list/mine", { bookid: bookId, synckey: 0, count: 200 }, key),
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

// content 二进制/损坏校验：epub ZIP 头 / NUL 字节 / U+FFFD 高密度
// 防止坏数据（如 epub 二进制被当文本读）进入锚定导致 O(n²) 卡死
export function isBrokenContent(content) {
  const s = String(content || "");
  if (!s.length) return true;
  if (s.startsWith("PK\u0003\u0004")) return true; // ZIP 头（epub 二进制）
  if (s.includes("\u0000")) return true; // NUL 字节
  const fffd = (s.match(/\uFFFD/g) || []).length;
  if (fffd > 0 && fffd / s.length > 0.01) return true; // 大量替换符（编码损坏）
  return false;
}

// 在原始段落里精确定位 markText，返回 {start, end}（原始字符偏移，完美重合）
// 优先原始精确匹配；失败则用归一化映射换算回原始位置（处理空白/引号差异）
// paraNorm 可选：该段已归一化文本（避免重复 normalize）
function exactAnchor(rawPara, markText, paraNorm) {
  const raw = String(rawPara ?? "");
  // 1. 原始精确匹配（先试 markText 原文，再试去空白版本）
  const rawTrimmed = markText.replace(/\s+/g, "");
  let idx = raw.indexOf(markText);
  if (idx < 0) idx = raw.indexOf(rawTrimmed);
  if (idx >= 0) return { start: idx, end: idx + rawTrimmed.length };

  // 2. 归一化匹配 + 映射回原始位置
  const pn = paraNorm ?? normalize(raw);
  const nMark = normalize(markText);
  const ni = pn.indexOf(nMark);
  if (ni < 0) return null;
  // 归一化位置 → 原始偏移：逐字符跳过被归一化的字符
  let start = -1, end = -1;
  let normIdx = 0;
  for (let j = 0; j < raw.length; j++) {
    const c = raw[j];
    if (!normalize(c)) continue; // 该字符被归一化掉（空白/引号等）
    if (normIdx === ni) start = j;
    if (normIdx === ni + nMark.length - 1) { end = j + 1; break; }
    normIdx++;
  }
  if (start < 0 || end <= start) return null;
  return { start, end };
}

// 锚定：单段优先，全文拼接兜底（支持跨段）。返回 {paragraph, start_char, end_char}（原始偏移，完美重合）
// 防御：markText 或段落异常长时跳过（避免极端输入卡死事件循环）
const MAX_ANCHOR_CHARS = 20000; // 单条 markText 超过此长度视为异常，跳过锚定
const MAX_PARAS_FOR_FULL = 200000; // 全文拼接索引总字符上限

export function anchorInParagraph(paragraphs, markText) {
  return anchorWithIndex(buildAnchorIndex(paragraphs), markText);
}

// 预构建锚定索引（一次，供多条 markText 复用，避免每条重建全文拼接 O(n²)）
export function buildAnchorIndex(paragraphs) {
  // 防御：总字符超限时仍可建索引，但全文匹配会受限
  const paraNorms = paragraphs.map((p) => normalize(p));
  const full = [];
  const paraOf = [];
  let total = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const pn = paraNorms[i];
    total += pn.length;
    for (let j = 0; j < pn.length; j++) { full.push(pn[j]); paraOf.push(i); }
  }
  return { paragraphs, paraNorms, fullStr: full.join(""), paraOf, total };
}

// 用预建索引锚定一条 markText
export function anchorWithIndex(index, markText) {
  const rawMark = String(markText || "");
  if (rawMark.length > MAX_ANCHOR_CHARS) return null; // 超长划线跳过（异常输入防御）
  const n = normalize(rawMark);
  if (!n) return null;
  const { paragraphs, paraNorms, fullStr, paraOf, total } = index;
  // 1. 单段精确匹配（优先）——用预归一化段，避免重复 normalize
  for (let i = 0; i < paragraphs.length; i++) {
    const ni = paraNorms[i].indexOf(n);
    if (ni >= 0) {
      // 换算回原始偏移（归一化映射）
      const exact = exactAnchor(paragraphs[i], rawMark, paraNorms[i]);
      if (exact) return { paragraph: i, start_char: exact.start, end_char: exact.end };
      return { paragraph: i, start_char: ni, end_char: ni + n.length };
    }
  }
  // 2. 全文拼接匹配（跨段划线）——防御：总字符超限跳过
  if (total > MAX_PARAS_FOR_FULL) return null;
  const idx = fullStr.indexOf(n);
  if (idx < 0) return null;
  const startPara = paraOf[idx];
  const rawPara = paragraphs[startPara];
  const exact = exactAnchor(rawPara, n, paraNorms[startPara]);
  if (exact) return { paragraph: startPara, start_char: exact.start, end_char: exact.end };
  // 兜底：段内归一化换算
  let acc = 0;
  for (let i = 0; i < startPara; i++) acc += paraNorms[i].length;
  const segStart = idx - acc;
  const paraLen = paraNorms[startPara].length;
  const end = Math.min(segStart + n.length, paraLen);
  if (end <= segStart) return null;
  return { paragraph: startPara, start_char: segStart, end_char: end };
}

// 是否完美重合：锚定位置切出的原文与 markText 归一化后一致
export function isPerfectAnchor(paragraphs, anchor, markText) {
  if (!anchor) return false;
  const raw = paragraphs[anchor.paragraph] || "";
  const sliced = raw.slice(anchor.start_char, anchor.end_char);
  return normalize(sliced) === normalize(markText);
}

// 锚定率（全量，用于门槛判断）
export function anchorRate(paragraphs, notes) {
  return anchorRateWithIndex(buildAnchorIndex(paragraphs), notes);
}

// 基于预建索引的锚定率（性能版，供批量场景复用索引）
export function anchorRateWithIndex(index, notes) {
  const samples = [...notes.underlines, ...notes.reviews.map((r) => ({ markText: r.abstract }))]
    .filter((n) => n.markText && n.markText.length > 8);
  let hit = 0;
  for (const s of samples) if (anchorWithIndex(index, s.markText)) hit++;
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
