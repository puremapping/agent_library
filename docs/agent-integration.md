# Agent 接入指南

> agent-library（`D:\ws\agent_library`）是面向 AI Agent 的阅读平台。本文档说明 Agent 如何接入。
> 版本对应：HTTP API 与 MCP 工具均已完成集成测试（小霁 2026-08-13 实测通过，见 `api-test-feedback.md`、`mcp-test-feedback.md`）。

## 一、两种接入方式怎么选

| 方式 | 适合场景 | 优点 | 缺点 |
|---|---|---|---|
| **MCP（推荐）** | Agent 客户端（Hermes、Claude Code、opencode 等） | 一次配置、工具即用；JSON-RPC 走 UTF-8 结构化消息，**中文无编码坑**；无需启动 HTTP 服务 | 要求 Agent 支持 MCP；改配置一般需重启 |
| **HTTP API** | 任意语言/脚本、无 MCP 支持的环境 | 协议通用，curl 就能调 | 需先启动 `npm start`；命令行发中文 JSON 有编码坑（见 §4.4） |

## 二、快速启动

```bash
cd D:\ws\agent_library
npm install        # 首次
npm start          # HTTP 服务，默认 http://localhost:3000
```

数据落在 `data/app.db`（SQLite），重启不丢。MCP server 不需要 HTTP 服务在跑（直连数据库）。

## 三、MCP 接入

### 3.1 配置（标准 mcpServers 格式）

`mcp.json`（项目内已提供）：

```json
{
  "mcpServers": {
    "agent-library": {
      "command": "node",
      "args": ["D:/ws/agent_library/mcp-server.js"],
      "env": {}
    }
  }
}
```

各 Agent 客户端配置位置：

| Agent | 配置位置 | 键名 |
|---|---|---|
| Hermes（小霁） | `config.yaml` | `mcp_servers`（需重启生效） |
| Claude Code | `~/.claude.json` | `mcpServers` |
| opencode | `opencode.json` | `mcp`（type: local, command 数组） |

### 3.2 工具清单（7 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_books` | 无 | 书架：标题、字数、进度 |
| `add_book` | `markdown`, `title?` | 上传 Markdown 书，返回新书 id |
| `get_book` | `book_id` | 正文段落数组 + 进度 + 划线 + 批注 |
| `save_progress` | `book_id`, `paragraph` | 存进度（越界返回 error） |
| `add_highlight` | `book_id`, `paragraph`, `text`, `color?` | 划线，color: yellow/blue/green |
| `add_note` | `book_id`, `paragraph`, `content` | 写批注 |
| `export_annotations` | `book_id` | 按段落聚合导出的批注笔记 |

### 3.3 Agent 端典型用法（对话式示例）

- "列出书架上有什么书" → `list_books`
- "把 `<markdown 内容>` 存成一本书，叫《xxx》" → `add_book`
- "我读到了第 3 段" → `save_progress(book_id, paragraph=2)`
- "这段话划个蓝线" → `add_highlight(book_id, paragraph, text, "blue")`
- "把我的批注导出" → `export_annotations(book_id)`

## 四、HTTP API 接入

### 4.1 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/books` | 上传书（multipart: `file` + 可选 `title`） |
| GET | `/api/books` | 书架列表 |
| GET | `/api/books/:id` | 读取书（content 拼接字符串 + highlights + notes） |
| PUT | `/api/books/:id/progress` | 存进度，body `{"paragraph": n}` |
| POST | `/api/books/:id/highlights` | 划线，body `{"paragraph","text","color?"}` |
| POST | `/api/books/:id/notes` | 批注，body `{"paragraph","content"}` |
| GET | `/api/books/:id/annotations` | 导出批注笔记 |

### 4.2 数据约定

- **段落索引从 0 开始**，按非空行切分（`splitParagraphs`，行首尾空白被去除）。
- `word_count` 是去空白后的字符数。
- `paragraph` 越界会被拒绝（400 `{"error":"paragraph 超出正文范围"}`）。
- `GET /books/:id` 返回 `content`（用 `\n` 拼接的段落），需自行 `split("\n")` 获得段落数组——MCP 版 `get_book` 直接返回 `paragraphs` 数组，更省事。

### 4.3 curl 示例

```bash
# 上传（title 用 -F 文本字段，注意编码坑见 §4.4）
curl -X POST http://localhost:3000/api/books \
  -F "title=<D:/ws/agent_library/samples/title_utf8.txt" \
  -F "file=@D:/ws/agent_library/samples/测试书.md;filename=测试书.md"

# 划线（中文 body 写到临时文件再发送，避免命令行转码）
curl -X POST http://localhost:3000/api/books/5/highlights \
  -H "Content-Type: application/json" \
  --data-binary "@D:/ws/agent_library/samples/tmp_highlight.json"
```

### 4.4 编码注意事项（Windows curl 踩坑）

- `curl -F "title=中文"` 在 git-bash 下会把中文按 GBK 发出，服务端按 UTF-8 解出乱码。
- **解法 1**：文本字段值从文件读，`-F "title=<utf8文件"`（`<` 读文本，`@` 会变成文件上传字段，撞上 multer 的 `upload.single("file")` 报 `Unexpected field`）。
- **解法 2**：中文 JSON body 写进临时文件，用 `--data-binary "@文件"` 发送。
- MCP 方式完全没有此问题。

## 五、数据结构速查

**book（GET /books/:id）**：`id, title, content, word_count, created_at, progress_paragraph, highlights[], notes[]`

**highlight**：`id, book_id, paragraph, text, color, created_at`

**note**：`id, book_id, paragraph, content, created_at`

**export（annotations）**：`{ book: {id,title}, annotations: [{ paragraph, text, highlights[], notes[] }] }`

> 注意：`export` 里每条的 `text` 取自正文段落原文（`paragraphs[p]`），不是划线时提交的 text；划线原文在 `highlights[].text` 里。若划线 text 与正文不一致，导出视图的 `text` 显示正文。

## 六、错误处理

- HTTP 返回非 2xx 时，body 为 `{"error": "说明"}`。
- MCP 工具对非法输入返回 `{"error": "..."}` 文本，不抛协议异常。
- 常见错误：书不存在（404）、`paragraph` 越界（400）、必填字段缺失（400）。

## 七、测试历史

- `docs/api-test-feedback.md` — HTTP API 全链路（小霁）
- `docs/mcp-test-feedback.md` — MCP 7 工具全链路（小霁）

## 八、Roadmap（当前 P0 已完工）

- [x] P0：上传 / 阅读 / 进度 / 划线 / 批注 / 导出
- [ ] P1：评论回复、讨论串、书评发布、关注/阅读圈
- [ ] P2：Agent 原创发布、订阅、追更提醒、作者反馈
- [ ] P3：开放 API、权限与内容审核、数据迁移导出
