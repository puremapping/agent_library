# MCP 一键接入提示词（发给你的 Agent）

> 用途：让你手头的 Agent（小霁 Hermes、Claude Code、或其它支持 MCP 的 Agent）接入 agent-library 读书平台。
> 用法：把下面的提示词整段复制发给 Agent，它会在自己的环境里按标准方式配置并验证。
> 若 Agent 不支持 MCP，把 `docs/agent-integration.md` 发给它走 HTTP API 方式即可。

---

请帮我在你的环境里接入一个本地 MCP 服务：agent-library（Agent 读书平台）。

**服务信息：**
- 启动命令：`node D:/ws/agent_library/mcp-server.js`
- 工作目录：`D:\ws\agent_library`
- 标准配置参考：`D:\ws\agent_library\mcp.json`
- 它通过 stdio 通信，直接读写 `D:\ws\agent_library\data\app.db`，**不需要** HTTP 服务在跑
- 工具名（7 个）：`list_books`、`add_book`、`get_book`、`save_progress`、`add_highlight`、`add_note`、`export_annotations`

**请你做的：**
1. 确认你的环境是否支持标准 MCP 客户端（`mcpServers` 配置格式）。
2. 用你环境的**标准 MCP 配置方式**把这个 server 注册进去（配置键名、字段格式按你自己的规范来，可参考上面 mcp.json 的内容）。
3. 配置完成后**不用重启会话**，用你环境当前支持的方式（如原生工具调用、或临时 MCP 客户端脚本）做一次验证，把工具名、参数、返回结果发我。
4. 验证流程（最少做前 3 项）：
   - `list_books` 列出当前书架
   - `get_book` 读取书 id=5
   - `add_book` 新建一本测试书（title 任取，内容 2-3 段 Markdown），记录返回的新 id
   - `save_progress` 给新书存进度 paragraph=0
   - `add_highlight` 给新书 paragraph=0 划一条线
   - `add_note` 给新书 paragraph=0 写一条批注
   - `export_annotations` 导出新书批注
5. 结束后**请清理你新建的测试书**（如果工具支持删除；不支持就告诉我留下的 id）。
6. 如果某步失败，把完整错误信息发我，并告诉我你的环境具体卡在哪。

**另外**：如果配置注册需要重启才生效，请明确告诉我"重启后是否会自动生效、要不要额外动作"。
