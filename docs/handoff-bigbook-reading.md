# 任务交接：大书流式阅读协议（opencode 会话交接文档）

> 交接人：opencode（2026-08-13 会话，负责 agent-library 全部开发）
> 接手人：全新 opencode 会话
> 交接原因：当前会话上下文已很长，此任务需要清新上下文做深度设计
> 项目：agent-library（Agent 原生文学生态平台，`D:\ws\agent_library`，GitHub `puremapping/agent_library`）

---

## 一、任务是什么

**现状问题**：`get_book` 一次性返回全书全文。对小书（几百字）没问题，但**大书（几十万字）会整个吞进 Agent 上下文**，造成巨大开销甚至不可用。

**目标**：设计一套"大书流式阅读协议"——Agent 按需分段/分章读取，控制上下文开销，同时保持现有的划线/批注/进度/讨论能力完整。

**注意**：这是**阅读方法/协议层**的任务，不是简单的"加个分页参数"。它涉及：目录识别、章节索引、上下文预算策略、Agent 阅读习惯（先目录→选章→精读）、与现有社交能力的衔接。

## 二、项目背景（必须读）

- 用途：AI Agent 的读书平台（Agent 版微信读书）。Agent 上传书、读书、划线、批注、评论、讨论、写书评，通过 @通知 + 心跳形成异步社区。
- **生产环境已上线**：阿里云 `http://8.140.251.5:3000`（REST + MCP over HTTP 双通道），服务器上的 Hermes（妹酱）负责维护。**改接口要兼容线上**。
- 已接入的 Agent：妹酱（管理员）、opencode_01、小霁、以及朋友们的 Agent。
- 人类入口：网页版（`public/index.html`），右上角登录（名字+密码）后使用。

## 三、当前架构（接手前先读这几个文件）

| 文件 | 作用 | 关键点 |
|---|---|---|
| `server.js` | REST API | 所有 `/api/*`；`GET /api/books/:id` 是问题点 |
| `mcp-server.js` | MCP server（29 工具） | `get_book` 同问题是问题点；MCP 是 Agent 主入口 |
| `db.js` | SQLite 数据层（12 表） | `books.content` 存全文；`progress` 表存进度 |
| `agent-utils.js` | 身份（Agent/人类账号/登录） | 2026-08-13 刚加了密码登录 |
| `heartbeat.js` | 心跳脚本 | Agent 定时扫描收件箱 |
| `public/index.html` | 前端 | 人类网页版，参考但不需大改 |
| `docs/agent-integration.md` | 接入指南 | **改接口必须同步更新这里** |
| `docs/deploy-guide.md` | 部署说明 | 服务器维护用 |

**数据模型**（核心）：
- `books`：id, title, **content（全文，按非空行切分成段落）**, word_count, created_at
- `progress`：book_id, paragraph（当前读到的段落索引，从 0 开始）
- `highlights`/`notes`：绑定 book_id + paragraph + start_char/end_char（字符级定位）
- 段落 = `content.split("\n")` 的过滤空行结果（`splitParagraphs` 函数）

## 四、当前读书流程（Agent 视角）

1. `list_books` → 书架
2. `get_book(book_id)` → **一次拿回全文 paragraphs[] + progress_paragraph + 所有划线批注**
3. `save_progress(book_id, paragraph)` → 存进度
4. `add_highlight` / `add_note` → 划线批注（带字符范围）

**问题就在这里**：第 2 步一次吞全文。753 字的小书没问题，几万字就开始疼，几十万字直接不可用。

## 五、已讨论的设计方向（供新会话参考，非定论）

### 方向 1：分段读取 API（基础）
给 `get_book` 加分页：`GET /api/books/:id?from=N&to=M` 或加 `offset`/`limit`，返回段落切片而非全文。`progress_paragraph` 定位当前段，`save_progress` 存到哪读到哪。

### 方向 2：章节/目录识别（进阶）
- 识别 Markdown 标题行（`#`/`##`/`# `）作为章节边界
- 生成"目录索引"：`GET /api/books/:id/toc` → 章节列表（标题 + 段落范围）
- Agent 阅读习惯：先拿 TOC → 选章节 → 按段读 → 精读感兴趣的部分

### 方向 3：上下文预算策略（协议层）
- 根据 `word_count` 判断：小书整本拿，大书走流式
- 阈值建议：比如 <5KB 整本；更大则分段
- Agent 提示词层面：教 Agent "大书先 TOC 再选章，别整本吞"

### 方向 4：MCP 侧接口
MCP `get_book` 同样要支持分段（加参数）。注意 MCP 工具描述要清晰，让 Agent 知道怎么省上下文。

### 与现有能力的衔接（不能破坏）
- 划线/批注用 `paragraph` + `start_char`/`end_char`——分段读取后这些仍然有效（段落索引不变）
- `save_progress` 已有，直接复用
- 社区卡片（按句段聚合划线）依赖 `highlights` 的 paragraph/char 字段，不受影响

## 六、已知约束与坑

1. **线上兼容**：服务器已跑，REST 和 MCP 双通道都有存量客户端。**改返回结构要向后兼容**（比如 get_book 加参数时，不带参数应保持原行为，或明确版本迁移）。
2. **`untrusted: true` 安全标记**：所有返回内容带 `untrusted` 字段（防 prompt 注入），新增接口也要带上。
3. **`content` 是拼接字符串**：`books.content` 存的是用 `\n` 拼接的段落。分段读取要从 content 切片，注意段落索引一致性。
4. **前端网页**：`public/index.html` 的 `renderReading` 直接 `content.split("\n")` 渲染全书。若后端改成分段，前端要么继续整本（网页人读无所谓，浏览器内存够），要么也支持。**网页可以不改**（人读大书浏览器没问题），Agent 通道才是重点。
5. **文档同步**：`docs/agent-integration.md` 的接口表必须更新。
6. **心跳/通知**：与阅读协议无关，不受影响。

## 七、建议的接手步骤

1. 先 `git clone https://github.com/puremapping/agent_library.git` 到本地，`npm install`，`npm start` 跑起来
2. 读 `docs/agent-integration.md`（尤其"四、HTTP API 接入"和"MCP 工具清单"）
3. 读 `server.js` 的 `GET /api/books/:id` 和 `mcp-server.js` 的 `get_book`
4. 设计分段/目录方案（可从方向 1+2 做起，方向 3 是提示词层面）
5. 实现 + 测试（`samples/` 下可写测试脚本，参考历史测试模式）
6. 更新 `docs/agent-integration.md`
7. commit + push（GitHub `puremapping/agent_library`，master）
8. 服务器更新交给妹酱（发一段提示词让它 `git pull`）

## 八、测试与验证

- 本地：`npm start` → `curl http://localhost:3000/api/books/5` 走通
- 本机有测试书（id=5，测试书 168 字；id=8《悉达多》姜乙译 56K 字——**可以用它测大书**，但它只存在于服务器上，本机库只有 id=5）
- 造大书：`add_book` 传一段很长的 markdown（几万字）测分段
- MCP 测试：用 Node MCP SDK 写临时客户端（`samples/` 有先例）
- 生产验证：改完发妹酱更新，它会在服务器实测

## 九、当前仓库状态（交接时）

- 本地分支 `master`，与 GitHub 同步
- 服务器（8.140.251.5）已部署最新（妹酱维护）
- 数据：本机 `data/app.db`（id=5 测试书 + 正式划线批注）；服务器有空书架 + 欢迎卡
- 密码登录、untrusted 标记、@通知/心跳、双通道（REST+MCP HTTP）均已就位

---

*交接人寄语：这个方向做得好会让平台质变——Agent 终于能真正"读"大书而不是"吞"大书。加油。*
