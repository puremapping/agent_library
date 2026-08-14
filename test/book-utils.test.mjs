import { test } from "node:test";
import assert from "node:assert/strict";
import { splitParagraphs, buildToc, parseRange, getParagraphs, clearParagraphCache } from "../book-utils.js";

// ---------- splitParagraphs ----------
test("splitParagraphs: 按非空行切分，去空白", () => {
  const input = "# 标题\n\n这是第一段。  \n  第二段。\n\n# 第二章\n";
  assert.deepEqual(splitParagraphs(input), ["# 标题", "这是第一段。", "第二段。", "# 第二章"]);
});

test("splitParagraphs: 空内容返回空数组", () => {
  assert.deepEqual(splitParagraphs(""), []);
  assert.deepEqual(splitParagraphs("\n\n  \n"), []);
});

test("splitParagraphs: 行首尾空白去除", () => {
  assert.deepEqual(splitParagraphs("   hello   \n  world  \n"), ["hello", "world"]);
});

// ---------- buildToc ----------
test("buildToc: Markdown 标题识别", () => {
  const paras = ["# 第一章", "正文一", "## 第二节", "正文二", "# 第二章", "正文三"];
  const toc = buildToc(paras);
  assert.equal(toc.has_headings, true);
  assert.equal(toc.chapters.length, 3);
  // 第一章从段0开始，到"## 第二节"(段2)结束（不含），含正文一
  assert.equal(toc.chapters[0].index, 0);
  assert.equal(toc.chapters[0].title, "第一章");
  assert.equal(toc.chapters[0].level, 1);
  assert.equal(toc.chapters[0].start_paragraph, 0);
  assert.equal(toc.chapters[0].end_paragraph, 2);
  assert.equal(toc.chapters[0].paragraph_count, 2);
  assert.equal(toc.chapters[0].word_count, 7); // "#第一章正文一"（含标题行，实现如此）
  assert.equal(toc.chapters[1].title, "第二节");
  assert.equal(toc.chapters[2].title, "第二章");
});

test("buildToc: 无标题 → 单章全书", () => {
  const toc = buildToc(["普通行", "再一行"]);
  assert.equal(toc.has_headings, false);
  assert.equal(toc.chapters.length, 1);
  assert.equal(toc.chapters[0].title, "全书");
  assert.equal(toc.chapters[0].paragraph_count, 2);
});

test("buildToc: 中文章节标题兜底", () => {
  const paras = ["第一章 相遇", "正文", "第二章 交流", "正文"];
  const toc = buildToc(paras);
  assert.equal(toc.has_headings, true);
  assert.equal(toc.chapters.length, 2);
  assert.equal(toc.chapters[0].title, "第一章 相遇");
});

test("buildToc: 正文含'第一章'不误判（有 md 标题时只用 md 规则）", () => {
  const paras = ["# 目录", "第一章的内容其实在这里", "## 正题"];
  const toc = buildToc(paras);
  assert.equal(toc.has_headings, true);
  // 只有 2 个 md 标题，正文"第一章的内容"不是标题
  assert.equal(toc.chapters.length, 2);
});

// ---------- parseRange ----------
test("parseRange: 默认整本", () => {
  assert.deepEqual(parseRange({}, 10), { from: 0, to: 10 });
});

test("parseRange: from+to", () => {
  assert.deepEqual(parseRange({ from: 2, to: 5 }, 10), { from: 2, to: 5 });
});

test("parseRange: from+limit（limit 优先于 to）", () => {
  assert.deepEqual(parseRange({ from: 3, limit: 4, to: 9 }, 10), { from: 3, to: 7 });
});

test("parseRange: to 超界截断", () => {
  assert.deepEqual(parseRange({ from: 0, to: 99 }, 10), { from: 0, to: 10 });
});

test("parseRange: 非法参数返回 error", () => {
  assert.ok(parseRange({ from: -1 }, 10).error);
  assert.ok(parseRange({ from: 99 }, 10).error);
  assert.ok(parseRange({ limit: -2 }, 10).error);
  assert.ok(parseRange({ to: 0 }, 10).error);
});

// ---------- getParagraphs（#7 缓存） ----------
// 用最小 mock db（只暴露 prepare().get()）
function mockDb(content) {
  return { prepare: () => ({ get: () => ({ content }) }) };
}

test("getParagraphs: 返回与 splitParagraphs 一致", () => {
  clearParagraphCache();
  const db = mockDb("a\n\nb\n");
  assert.deepEqual(getParagraphs(db, 1), ["a", "b"]);
});

test("getParagraphs: 相同内容命中缓存（返回同一数组引用）", () => {
  clearParagraphCache();
  const db = mockDb("x\ny\n");
  const first = getParagraphs(db, 7);
  const second = getParagraphs(db, 7);
  assert.equal(second, first); // 命中缓存，返回同一引用（没重新切分）
});

test("getParagraphs: 内容变化自动失效", () => {
  clearParagraphCache();
  let content = "old\ncontent\n";
  const db = { prepare: () => ({ get: () => ({ content }) }) };
  const first = getParagraphs(db, 3);
  assert.deepEqual(first, ["old", "content"]);
  content = "new\ncontent\n";
  const second = getParagraphs(db, 3);
  assert.deepEqual(second, ["new", "content"]); // content 变了，重新切分
  assert.notEqual(second, first);
});
