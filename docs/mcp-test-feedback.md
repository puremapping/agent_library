# Agent Library MCP Server 集成测试反馈

- **测试日期**：2026-08-13
- **测试者**：小霁（Hermes Agent）
- **被测对象**：agent-library MCP server（`mcp-server.js`，stdio 传输，直接读写 `data/app.db`）
- **测试方式**：标准 MCP 协议客户端（Node MCP SDK 1.30.0，项目自带依赖），走完整 initialize → tools/list → tools/call 握手
- **相关文档**：HTTP API 集成测试见 `api-test-feedback.md`

## 结论

**全链路 7 个工具全部测试通过 ✅**：list_books / get_book / add_book / save_progress / add_highlight / add_note / export_annotations，标准 MCP 协议握手正常、工具注册正常、中文内容正确落库与读出。

## 环境支持情况（回答"接入方式"问题）

- **支持**：Hermes 内置 native MCP 客户端，标准 `mcpServers` 配置格式（`mcp.json` 可平移）。
- **配置路径**：Hermes 的配置是 `mcp_servers` 键（`config.yaml`），工具注册为 `mcp_agent-library_*` 前缀；**改配置需重启 Hermes 生效**（无热加载），当前会话未采用。
- **命令方式（本次实测采用）**：mcporter 未装、Python mcp 包未装，但项目自带 Node MCP SDK——用 SDK 写标准客户端经 stdio 连接，与任何标准 MCP 客户端接入等价，不动配置、不重启。

## 完整测试记录（工具名 + 参数 + 返回）

### 0. tools/list — 协议发现

注册工具（7 个）：

```
list_books, add_book, get_book, save_progress, add_highlight, add_note, export_annotations
```

### 1. list_books

参数：`{}`

返回（书架上两本书）：

```json
[
  { "id": 5, "title": "测试书", "word_count": 168, "created_at": "2026-08-13 07:24:21", "progress_paragraph": 7 },
  { "id": 7, "title": "MCP小霁测试", "word_count": 83, "created_at": "2026-08-13 07:51:15", "progress_paragraph": 1 }
]
```

> 注：与 HTTP 测试时相比，**id=1~4 已不存在**（乱码残留与旧测试书已被清理）；id=5 的进度从 5 变为 7、多了一条 green 划线——说明库在本次测试前被另行操作过，以下 get_book(5) 读到的是最新状态。

### 2. get_book — book_id=5

参数：`{"book_id": 5}`

返回要点：8 段正文完整（paragraphs 数组）、progress_paragraph=7、highlights 2 条（id=2 blue、id=3 green，均在 paragraph 6）、notes 1 条（id=2，内容「这是一条来自小霁的测试批注。」）——与预期一致，正文段落和已有划线/批注均能拿到 ✅

### 3. add_book — 新建测试书

参数：

```json
{
  "markdown": "这是通过 MCP 协议上传的测试书。段落索引从 0 开始，这段是第 0 段。\n\nMCP 让 Agent 可以直接读写书架，无需 HTTP 服务器在跑。\n\n小霁的 MCP 集成测试，验证标准协议全链路。",
  "title": "MCP小霁测试"
}
```

返回：

```json
{ "id": 7, "title": "MCP小霁测试", "word_count": 83, "paragraph_count": 3 }
```

### 4. save_progress — book_id=7, paragraph=1

参数：`{"book_id": 7, "paragraph": 1}`

返回：

```json
{ "ok": true, "paragraph": 1 }
```

### 5. add_highlight — book_id=7, paragraph=0（text 用正文第 1 段原文）

参数：

```json
{
  "book_id": 7,
  "paragraph": 0,
  "text": "这是通过 MCP 协议上传的测试书。段落索引从 0 开始，这段是第 0 段。",
  "color": "blue"
}
```

返回：

```json
{ "id": 4, "book_id": 7, "paragraph": 0, "text": "这是通过 MCP 协议上传的测试书。段落索引从 0 开始，这段是第 0 段。", "color": "blue", "created_at": "2026-08-13 07:51:15" }
```

### 6. add_note — book_id=7, paragraph=0

参数：`{"book_id": 7, "paragraph": 0, "content": "来自小霁的 MCP 测试"}`

返回：

```json
{ "id": 3, "book_id": 7, "paragraph": 0, "content": "来自小霁的 MCP 测试", "created_at": "2026-08-13 07:51:15" }
```

### 7. export_annotations — book_id=7

参数：`{"book_id": 7}`

返回要点：paragraph 0 正确聚合 1 条 blue 划线 + 1 条批注，`text` 为正文第 1 段原文 ✅

```json
{
  "book": { "id": 7, "title": "MCP小霁测试" },
  "annotations": [
    {
      "paragraph": 0,
      "text": "这是通过 MCP 协议上传的测试书。段落索引从 0 开始，这段是第 0 段。",
      "highlights": [{ "id": 4, "book_id": 7, "paragraph": 0, "text": "这是通过 MCP 协议上传的测试书。段落索引从 0 开始，这段是第 0 段。", "color": "blue", "created_at": "2026-08-13 07:51:15" }],
      "notes": [{ "id": 3, "book_id": 7, "paragraph": 0, "content": "来自小霁的 MCP 测试", "created_at": "2026-08-13 07:51:15" }]
    }
  ]
}
```

## MCP 版与 HTTP 版的差异观察（非 bug，供参考）

1. **新增 paragraph 越界校验**（MCP 版有、HTTP 版没有）：`save_progress` / `add_highlight` / `add_note` 都会先查 `paragraphWithinRange`，越界返回 `{"error":"paragraph 超出正文范围"}`。HTTP 版越界段落导出时 `text` 为空串，MCP 版从源头挡住了。
2. **返回结构升级**：`get_book` 直接返回 `paragraphs` 数组 + `paragraph_count`（HTTP 版返回拼接的 content 字符串，需自行 split）；`add_book` 返回 `paragraph_count`；`save_progress` 返回保存后的 `paragraph`。
3. **title 缺省值不同**：MCP `add_book` 缺省 title 为「未命名」，HTTP 版缺省取文件名。
4. **export_annotations 的 `text` 同源问题与 HTTP 版一致**：`text` 取正文段落原文（`paragraphs[p]`），划线原文在 `highlights[].text` 里——若划线 text 与正文不同，导出视图的 `text` 仍是正文。
5. **中文全程无编码问题**：MCP 走 JSON-RPC（UTF-8 结构化消息），完全绕开了命令行 curl 的 GBK 转码坑——这是 MCP 相比裸 HTTP+curl 测试体验更好的点。

## 测试残留

- 按指示**未清理 id=7**（MCP小霁测试，含 1 条 blue 划线 + 1 条批注），由 opencode 自行处理。
- 临时 MCP 客户端脚本（`hermes-verify-mcp-test.mjs`、`Temp\hermes-verify-mcp-data.mjs`）已全部删除。

## 踩坑记录（测试客户端侧，非 server 问题）

- **MCP SDK 1.30.0 的 exports map 用 `./*` 通配**：物理路径不是 `client/index.js`，从项目外（如 Temp）用 `file://` 绝对路径 import 会报 `ERR_MODULE_NOT_FOUND`。解法：`createRequire("D:/ws/agent_library/package.json")` 锚定项目目录，让 Node 走 exports map 解析。已 patch 进 native-mcp skill 的 troubleshooting。
