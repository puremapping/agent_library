// 大书流式阅读协议：段落切分 + 目录/章节识别 + 分段参数解析
// 供 server.js（REST）与 mcp-server.js（MCP）共用，保证段落索引一致。

// 逻辑段落：按非空行切分，行首尾去空白。（本书格式规范 §二）
export function splitParagraphs(content) {
  return content
    .split(/\r?\n/)
    .filter((p) => p.trim().length > 0)
    .map((p) => p.trim());
}

// ---------- 段落缓存（#7） ----------
// 大书（几万字/几千段）下 splitParagraphs 是 O(整本书)，每次划线/批注/越界校验都重算很浪费。
// 简单内存缓存：key=book_id，value={ content, paragraphs }。
// content 相同则直接复用；书内容变化（更新）时自然失效（content 哈希不同）。
const paragraphCache = new Map();
const CACHE_MAX = 200;

export function getParagraphs(db, bookId) {
  const book = db.prepare("SELECT content FROM books WHERE id = ?").get(bookId);
  if (!book) return null;
  const cached = paragraphCache.get(bookId);
  if (cached && cached.content === book.content) return cached.paragraphs;
  const paragraphs = splitParagraphs(book.content);
  // 简单 LRU：超过上限删最早的
  if (paragraphCache.size >= CACHE_MAX) {
    const firstKey = paragraphCache.keys().next().value;
    paragraphCache.delete(firstKey);
  }
  paragraphCache.set(bookId, { content: book.content, paragraphs });
  return paragraphs;
}

export function clearParagraphCache() {
  paragraphCache.clear();
}

// ---------- 章节识别（本书格式规范 §3.3） ----------

const MD_HEADING_RE = /^(#{1,6})\s+/;
// 中文章节标题（兜底启发式）：'第X章/回/节/篇/部/集/卷'，标题后必须跟 空白/行尾/标点，
// 避免把正文"第1章的第0段正文"这类行首引用误判为标题
const CN_CHAPTER_RE = /^第[0-9零一二三四五六七八九十百千万]{1,6}[章节回篇部集卷](?=[\s]|$|[\u3000，。！？、：；"'》）])/;

// 从段落数组生成目录。每个标题行开启一章，到下一个标题行（不含）为止。
// 识别策略（本书格式规范 §3.3）：先看全书是否含 Markdown 标题行（#/##）。
//   - 含 → 只用 Markdown 标题规则（正文里提到"第一章"不会被误判）
//   - 不含 → 启用中文章节标题兜底启发式（"第一章""第1回"等）
// 全书无任何可识别标题时返回单章"全书"（start=0, end=全书段落数），has_headings=false。
export function buildToc(paragraphs) {
  const useMd = paragraphs.some((p) => MD_HEADING_RE.test(p));
  const isHeading = useMd ? (p) => MD_HEADING_RE.test(p) : (p) => CN_CHAPTER_RE.test(p);
  const titleOf = useMd ? (p) => p.replace(/^#{1,6}\s+/, "").trim() : (p) => p.trim();
  const levelOf = useMd ? (p) => (p.match(/^#{1,6}/) || [""])[0].length : () => 0;

  const chapters = [];
  let current = null;

  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i];
    if (isHeading(line)) {
      if (current) {
        current.end = i;
        chapters.push(finalizeChapter(current, paragraphs));
      }
      current = { index: chapters.length, title: titleOf(line), level: levelOf(line), start: i, end: i };
    }
  }
  if (current) {
    current.end = paragraphs.length;
    chapters.push(finalizeChapter(current, paragraphs));
  }

  if (!chapters.length) {
    return {
      has_headings: false,
      chapters: [
        {
          index: 0,
          title: "全书",
          level: 0,
          start_paragraph: 0,
          end_paragraph: paragraphs.length,
          paragraph_count: paragraphs.length,
          word_count: paragraphs.join("\n").replace(/\s/g, "").length,
        },
      ],
    };
  }
  return { has_headings: true, chapters };
}

function finalizeChapter(ch, paragraphs) {
  const body = paragraphs.slice(ch.start, ch.end).join("\n");
  return {
    index: ch.index,
    title: ch.title,
    level: ch.level,
    start_paragraph: ch.start,
    end_paragraph: ch.end, // 不含
    paragraph_count: ch.end - ch.start,
    word_count: body.replace(/\s/g, "").length,
  };
}

// ---------- 分段参数解析（方向 1：get_book 分段） ----------
// query: { from?, to?, limit? }，返回 { from, to }（[from, to) 左闭右开）。
// - 不传 = 整本
// - from+to：精确区间；from+limit：取 from 起 limit 段；limit 优先于 to
export function parseRange(query, total) {
  const { from, to, limit } = query;

  let start = 0;
  if (from != null) {
    if (!Number.isInteger(Number(from)) || Number(from) < 0) return { error: "from 必须是 ≥0 的整数" };
    start = Number(from);
  }
  if (start >= total) return { error: "from 超出正文范围" };

  let end = total;
  if (limit != null) {
    if (!Number.isInteger(Number(limit)) || Number(limit) < 0) return { error: "limit 必须是 ≥0 的整数" };
    end = start + Number(limit);
  } else if (to != null) {
    if (!Number.isInteger(Number(to)) || Number(to) <= 0) return { error: "to 必须是 >0 的整数" };
    end = Number(to);
  }
  end = Math.min(end, total);

  return { from: start, to: end };
}
