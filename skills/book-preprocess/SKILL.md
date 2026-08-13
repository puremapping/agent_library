---
name: book-preprocess
displayName: Book Preprocess (Agent Library)
description: 把 txt/PDF/EPUB 等来源的书籍内容转换成 agent-library 平台推荐的规范 Markdown（标题行分章、UTF-8、去空行）后再上传，以获得完整目录（get_toc）与最佳流式阅读体验。当 Agent 需要向 agent-library 上传书籍、且原始格式不是规范 Markdown 时使用此 skill。
version: 1.0.0
categories: [learning, research]
roles: [student, researcher, personal-user]
outputs: [document, text]
scenarios: [learning-growth, research-insights]
platforms: [openclaw, claude-code, codex, gemini]
tags: [reading, book, markdown, conversion, format]
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

### 1. 取原文

支持源：`.txt`、`.pdf`、`.epub`、`.md`（不规范的）、剪贴板文本、网页正文。

提取方式按手头工具选用：
- **txt/md**：直接读文本
- **PDF**：可用 `pdftotext`（poppler）、`pandoc` 或 PDF 阅读器导出
- **EPUB**：`pandoc book.epub -t markdown -o book.md`
- **网页正文**：阅读器/浏览器"阅读模式"导出，或抓取 `<article>` 主体文本

### 2. 识别章节结构

在原文中找出章节边界，逐章加标题行：

- 若原文已有章节标题（如"第一章 …"、目录页），保留并统一为 `# 标题` 行。
- 若没有明显章节，按语义划分（每个大主题一段），每段配 `# 标题`。宁可粗分（每章 1~2 千字）不要整本一团。
- 保留原文的章内小标题（如"1.1 背景"）为 `##` 级。

### 3. 清洗

- 去除页眉页脚、页码、水印、OCR 噪声行（如孤立数字、"第 x 页"）。
- 合并被硬换行截断的行（PDF 常见）：连续两行同段应合并为一段。
- 去除空行（服务端也会去，但自己清干净更省）。
- 保留正文里的 Markdown 标记（`**粗体**`、`*斜体*`、引用、代码块）——它们对人类和 Agent 都有意义。

### 4. 输出并上传

- 输出一份 UTF-8 的 `.md` 文件（临时或与书同放）。
- 上传：MCP `add_book(markdown=..., title=...)`，或 HTTP `POST /api/books`（multipart `file` + `title`）。
- 上传后可调 `get_toc` 验证目录是否识别正确（每章都有 start_paragraph/end_paragraph 即成功）。

## 上传源格式不佳时（选做）

若坚持原样上传（保留原始排版、故意"暴露格式糟糕"），仍可传——平台不拒收。
区别只在：没有标题标记的书 `get_toc` 只能返回单章"全书"，流式阅读时需用 `from`/`limit` 手工分段。
是否预处理由上传者决定，但**推荐预处理以获得完整目录**。

## 原则

- 转换是为了让书"可被读"，不要改正文语义；清洗只去噪声，不重写内容。
- 章节划分以原文结构为准，不要自行重新组织作者的章节。
- 遇到不确定的章节归属，宁归前章，不另起无名章。
