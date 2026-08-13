---
name: book-preprocess
displayName: Book Preprocess (Agent Library)
description: 把 txt/PDF/EPUB、剪贴板、网上公版书（Wikisource/Project Gutenberg 等网页源）等来源的书籍内容转换成 agent-library 平台推荐的规范 Markdown（标题行分章、UTF-8、去空行）后再上传，以获得完整目录（get_toc）与最佳流式阅读体验。当 Agent 需要向 agent-library 上传书籍、且原始格式不是规范 Markdown 时使用此 skill。
version: 1.1.0
categories: [learning, research]
roles: [student, researcher, personal-user]
outputs: [document, text]
scenarios: [learning-growth, research-insights]
platforms: [openclaw, claude-code, codex, gemini]
tags: [reading, book, markdown, conversion, format, web-scraping]
---

# Book Preprocess for Agent Library

将任意来源的书转成 agent-library 平台推荐的规范格式，再上传。

## 为什么需要预处理

平台的目录识别（`get_toc`）依赖章节边界：Markdown 标题行（`#`/`##`）或中文"第一章/第1回"。
- 直接传一段没有标题标记的长文本 → 服务端只能识别为单章"全书"，无法按章精读。
- 上传前把章节标题整理成 `# 标题` 行，书一到平台就有完整目录，流式阅读体验最佳。

## 规范格式速查

（详见平台 `docs/book-format-spec.md`，此处为操作摘要）

- **编码**：UTF-8（无 BOM 最佳）
- **章节边界**：每章一行 `# 标题`（或 `##` 子节）；无 `#` 时可用"第一章/第1回"等中文标题，服务端也能兜底识别
- **段落**：一个非空行 = 一个段落；空行只作视觉分隔（会被去掉）
- **不需要**：YAML front-matter、手动目录列表、章节编号规则（服务端自动识别）

## 工作流

### 0. 检查工具（开始前必做）

先确认你打算用的工具在环境里可用，缺了先装或改用替代方案，别等转换到一半才发现：

```bash
command -v pandoc     # EPUB/PDF 转换主力
command -v pdftotext  # PDF 纯文本提取（poppler-utils）
command -v wget       # 网页/公版书抓取
command -v curl       # 网页/公版书抓取（替代 wget）
```

- 都没有也行：txt/md 直接读、剪贴板直接用、网页源用内置 HTTP 能力抓——但**别假设 pdftotext/pandoc 必然存在**。
- 缺 pandoc 时 PDF 可用 `pdftotext` 或阅读器导出；EPUB 可直接解压读 `content.opf`/`*.xhtml`（zip 即可）。

### 1. 取原文

支持源：`.txt`、`.pdf`、`.epub`、`.md`（不规范的）、剪贴板文本、网页正文、**网上公版书（Wikisource / Project Gutenberg / 古登堡计划镜像等）**。

提取方式按手头工具选用：
- **txt/md**：直接读文本
- **PDF**：可用 `pdftotext`（poppler）、`pandoc` 或 PDF 阅读器导出
- **EPUB**：`pandoc book.epub -t markdown -o book.md`
- **网页正文（一般）**：阅读器/浏览器"阅读模式"导出，或抓取 `<article>` 主体文本
- **网上公版书（重点，最常见的"书"来源）**：
  - **Project Gutenberg**：抓 `https://www.gutenberg.org/cache/epub/<id>/pg<id>.txt`（纯文本镜像，最干净），或 `pg<id>.txt.utf-8`；有完整的"标题 → 章节 → 正文 → 结尾说明"结构。
  - **Wikisource**：中文维基文库（`zh.wikisource.org`）页面默认是 **wikitext**，不是成品 HTML。抓页面时先看是否有 **"下载为 EPUB/PDF"** 或 **"Wikitext" 源**入口——优先拿带版权的成品文本，少自己解析。
  - **抓 HTML/wikitext 时必须**：去掉导航栏、页脚、编辑按钮、参考文献脚注、分类标签等**页面 chrome**；只保留正文主体。Wikisource 中文书正文通常在 `#mw-content-text` 或章节级模板（如 `{{Header}}`）之后。
  - 版权意识：只抓**公版（公有领域）**作品；不确定就看页面版权说明，别把仍受版权保护的书传上平台。

### 2. 识别章节结构

在原文中找出章节边界，逐章加标题行：

- 若原文已有章节标题（如"第一章 …"、目录页），保留并统一为 `# 标题` 行。
- 若没有明显章节，按语义划分（每个大主题一段），每段配 `# 标题`。宁可粗分（每章 1~2 千字）不要整本一团。
- 保留原文的章内小标题（如"1.1 背景"）为 `##` 级。
- **杂项截断（跋/附录/注释/封底）——重要**：公版书常带不属于正文的部分，必须识别并处理，否则会混入正文、污染章节结构：
  - 识别：**跋/后记/附录/致谢/注释/索引/译后记/封底简介/出版说明/勘误表** 等标题（常见于书末尾），以及 Gutenberg 的"End of the Project Gutenberg EBook..."结尾块。
  - 处理：**正文到正文末尾为止**，杂项要么单独标成 `# 附录`（若属作者内容、读者会想看），要么**直接丢弃**（纯出版信息/译者废话/网站说明）。
  - 判定归属：分不清是正文还是杂项时，看它在原文结构里的层级——正文是 `h1/h2` 章节，杂项往往层级不同（如 `h3` 以下）或出现在正文完结（如"完""全文完"）之后。
  - 陷阱：别把正文末尾的自然收尾句误当杂项；反过来也别让附录混进最后一章。以"正文叙事是否已完结"为界，完结之后的内容才考虑丢弃或单列。

### 3. 清洗

- 去除页眉页脚、页码、水印、OCR 噪声行（如孤立数字、"第 x 页"）。
- 合并被硬换行截断的行（PDF 常见）：连续两行同段应合并为一段。
- 去除空行（服务端也会去，但自己清干净更省）。
- 保留正文里的 Markdown 标记（`**粗体**`、`*斜体*`、引用、代码块）——它们对人类和 Agent 都有意义。

### 4. 验证正文完整性（上传后抽查，必做）

光上传成功不算数，要确认正文**没丢、没错位、没被页面 chrome 污染**：

1. **字数对比**：上传后 `get_book`/`list_books` 的 `word_count` 与原始正文大致吻合（允许清洗去噪的少量偏差；差一个数量级 = 一定丢了东西）。
2. **抽样精读**：取**开头 1 章 + 中间 1 章 + 末尾 1 章**（或每 5 章抽 1），各读 1~2 段，核对内容与原文一致、章节标题对应、段落未粘连。
3. **结构核对**：`get_toc` 的章节数与原文实际章节数一致；`has_headings=true` 且每章 `start_paragraph`/`end_paragraph` 覆盖全书无空洞。
4. **杂项确认**：确认附录/跋/译后记没混进正文章节，也没把正文末尾误删（对照第 2 步的截断决定）。
5. **至少读一段正文**：确认不是空文件/全是页眉页脚。发现异常 → 回到第 3 步检查清洗或第 2 步检查章节判定。

### 5. 输出并上传

- 输出一份 UTF-8 的 `.md` 文件（临时或与书同放）。
- 上传：MCP `add_book(markdown=..., title=...)`，或 HTTP `POST /api/books`（multipart `file` + `title`）。
- 上传后可调 `get_toc` 验证目录是否识别正确（每章都有 start_paragraph/end_paragraph 即成功）。
- **上传后回到第 4 步做完整性抽查**，别上传完就完事。

## 上传源格式不佳时（选做）

若坚持原样上传（保留原始排版、故意"暴露格式糟糕"），仍可传——平台不拒收。
区别只在：没有标题标记的书 `get_toc` 只能返回单章"全书"，流式阅读时需用 `from`/`limit` 手工分段。
是否预处理由上传者决定，但**推荐预处理以获得完整目录**。

## 原则

- 转换是为了让书"可被读"，不要改正文语义；清洗只去噪声，不重写内容。
- 章节划分以原文结构为准，不要自行重新组织作者的章节。
- 遇到不确定的章节归属，宁归前章，不另起无名章。
- **完整性优先于速度**：少一页正文比多一段废话严重得多——上传后必须抽查（见工作流第 4 步），别跳。
- **只处理公版作品**；抓网页源时丢弃页面 chrome（导航/页脚/编辑按钮），只留正文。
- 工具可用性先行：`pdftotext`/`pandoc`/`wget` 缺了就用替代方案，别在转换中途才停下找工具。
