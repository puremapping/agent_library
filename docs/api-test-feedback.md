# Agent Library API 集成测试反馈

- **测试日期**：2026-08-13
- **测试者**：小霁（Hermes Agent）
- **被测服务**：agent-library（本地 Agent 读书平台 API），http://localhost:3000
- **测试样本**：`samples/测试书.md`（8 个非空段落，索引 0–7）

## 结论

**8 步全链路测试全部通过 ✅**：上传 → 书架 → 读取 → 进度 → 划线 → 批注 → 导出，所有返回 JSON 符合预期，中文内容（正文、划线、批注）在服务端正确落库、正确读出。

## 关键偏差：测试书实际 id=5，不是 1

- 库中已存在旧数据：`id=1`（title=测试书，327 字，progress_paragraph=2，07:01 创建，疑似更早测试遗留）。
- 本次上传返回 `id=5`。**后续全部步骤均对 id=5 执行**，确保测的是"刚上传的这本书"。

## 完整请求记录（命令 + 原始返回）

### 1. 上传书 — `POST /api/books`

```bash
curl -s -X POST http://localhost:3000/api/books \
  -F "title=<D:/ws/agent_library/samples/title_utf8.txt" \
  -F "file=@D:/ws/agent_library/samples/测试书.md;filename=测试书.md"
```

返回：

```json
{"id":5,"title":"测试书","word_count":168}
```

> 注：首次用 `-F "title=测试书"` 直传时 title 落库为乱码（见下文问题 ①）；此处为验证过正确编码后的正式上传。

### 2. 列出书架 — `GET /api/books`

```bash
curl -s http://localhost:3000/api/books
```

返回（节选，按 created_at 倒序）：

```json
[{"id":5,"title":"测试书","word_count":168,"created_at":"2026-08-13 07:24:21","progress_paragraph":5},
 {"id":4,"title":"������","word_count":168,"created_at":"2026-08-13 07:24:11","progress_paragraph":0},
 {"id":3,"title":"������","word_count":168,"created_at":"2026-08-13 07:23:58","progress_paragraph":0},
 {"id":2,"title":"������","word_count":168,"created_at":"2026-08-13 07:23:09","progress_paragraph":0},
 {"id":1,"title":"测试书","word_count":327,"created_at":"2026-08-13 07:01:03","progress_paragraph":2}]
```

### 3. 读取书内容 — `GET /api/books/5`

```bash
curl -s http://localhost:3000/api/books/5
```

返回（正文 8 段完整，highlights/notes 为空数组）：

```json
{"id":5,"title":"测试书","content":"这是一本用于 API 集成测试的测试书。\n阅读，是一种与作者跨越时空的对话。\n当我们翻开一本书，我们其实在打开另一个人的世界。\n每一段文字背后，都有一个人的思考与生活。\n阅读的价值，不在于读了多少本，而在于吸收了多少。\n书是朋友，也是镜子；它照见我们，也改变我们。\n真正的阅读，是把别人的思想变成自己的旅程。\n读完之后，合上书页，那些句子已经在心里生根。","word_count":168,"created_at":"2026-08-13 07:24:21","progress_paragraph":0,"highlights":[],"notes":[]}
```

### 4. 保存阅读进度 — `PUT /api/books/5/progress`

```bash
curl -s -X PUT http://localhost:3000/api/books/5/progress \
  -H "Content-Type: application/json" -d '{"paragraph": 5}'
```

返回：

```json
{"ok":true}
```

持久化验证：`GET /api/books/5` 返回 `"progress_paragraph":5` ✅

### 5. 划线 — `POST /api/books/5/highlights`

body 写入临时文件避免中文转码，用 `--data-binary "@文件"` 发送：

```bash
curl -s -X POST http://localhost:3000/api/books/5/highlights \
  -H "Content-Type: application/json" \
  --data-binary "@D:/ws/agent_library/samples/tmp_highlight.json"
```

body 文件内容：`{"paragraph": 6, "text": "真正的阅读，是把别人的思想变成自己的旅程。", "color": "blue"}`

返回：

```json
{"id":2,"book_id":5,"paragraph":6,"text":"真正的阅读，是把别人的思想变成自己的旅程。","color":"blue","created_at":"2026-08-13 07:24:44"}
```

### 6. 写批注 — `POST /api/books/5/notes`

```bash
curl -s -X POST http://localhost:3000/api/books/5/notes \
  -H "Content-Type: application/json" \
  --data-binary "@D:/ws/agent_library/samples/tmp_note.json"
```

body 文件内容：`{"paragraph": 6, "content": "这是一条来自小霁的测试批注。"}`

返回：

```json
{"id":2,"book_id":5,"paragraph":6,"content":"这是一条来自小霁的测试批注。","created_at":"2026-08-13 07:24:52"}
```

### 7. 导出批注 — `GET /api/books/5/annotations`

```bash
curl -s http://localhost:3000/api/books/5/annotations
```

返回（划线 + 批注均在 paragraph 6 下正确聚合）：

```json
{"book":{"id":5,"title":"测试书"},
 "annotations":[{"paragraph":6,
   "text":"真正的阅读，是把别人的思想变成自己的旅程。",
   "highlights":[{"id":2,"book_id":5,"paragraph":6,"text":"真正的阅读，是把别人的思想变成自己的旅程。","color":"blue","created_at":"2026-08-13 07:24:44"}],
   "notes":[{"id":2,"book_id":5,"paragraph":6,"content":"这是一条来自小霁的测试批注。","created_at":"2026-08-13 07:24:52"}]}]}
```

## 发现的问题

### ① curl 中文编码坑（客户端问题，非 API bug）

- `curl -F "title=测试书"` 和 `--form-string` 在 Windows git-bash 下都会把 title 存成乱码（`������`）。根因：MSYS 把命令行参数转成 GBK 字节发出，服务端按 UTF-8 解码。
- **正文完全正常**（文件内容字节透传），证明 API 的 UTF-8 处理没有问题。
- **已验证解法**：`printf '测试书' > utf8.txt`（用 `xxd` 核对字节）后 `curl -F "title=<utf8.txt"`——`<` 从文件读文本字段值，字节不经过 MSYS 转码。
- **`<` vs `@` 区别**：`-F "字段=@文件"` 会把该字段变成文件上传字段（带 filename）——multer `upload.single("file")` 只收一个文件字段，会报 `MulterError: Unexpected field`。**文本字段用 `<`，真正的文件上传用 `@`**。
- 中文 JSON body 同理：写临时 json 文件 + `--data-binary "@文件"`。
- 另注意 `-F "字段=@/tmp/文件"` 会因原生 curl 不认 MSYS `/tmp` 路径报 exit 26（CURLE_READ_ERROR），用 `D:/...` 或相对路径。

### ② 建议清理的测试残留

当前库中 5 本书：**id=2/3/4 是编码实验产生的乱码 title 书**（168 字，与 id=5 内容相同），建议删除；id=1 是更早的旧测试书（如需清库可一并处理）。正式测试数据在 **id=5**：title=测试书、进度=5、划线 1 条（paragraph 6, blue）、批注 1 条（paragraph 6）。

## API 行为观察（供参考，非 bug）

1. **段落索引从 0 开始**，按非空行切分（`splitParagraphs`）。测试书 8 段 → 索引 0–7，paragraph 6 有效。
2. **`word_count=168` 是去空白后的字符数**（`content.replace(/\s/g,"").length`），不是段数或原始字数。
3. **`GET /api/books/:id/annotations` 的 `text` 字段取自正文段落原文**（`paragraphs[p]`），不是划线时提交的 text；划线文本在 `highlights[].text` 里。本次恰好正文第 7 段与划线文本相同，容易误以为同源——如果某条划线 text 与正文不同，导出视图的 `text` 会显示正文而非划线原文。
4. **paragraph 越界无校验**：highlights/notes 只校验整数，不校验是否超出正文范围，越界段落导出时 `text` 为空串。是否需要加校验由你决定。
5. **PUT progress 返回 `{ok:true}`**，不返回保存后的值；已通过 `GET /api/books/5` 确认持久化生效。

## 环境备注（与 API 无关）

git-bash 下 `python` 命令命中 Windows Store stub（exit 49），需用完整路径（如 `D:/fs/70_Software/hermes-agent/venv/Scripts/python.exe`）。测试本身全部用 curl 完成，未依赖 Python。
