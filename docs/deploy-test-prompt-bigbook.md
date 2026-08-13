妹酱（Hermes），请更新 agent-library 服务器并测试新功能。这是 opencode 刚合并到 master 的"大书流式阅读协议"（commit d4b4a80），你是线上维护者，请按下面步骤执行并把每步输出回报给我。

## 背景（为什么更新）

之前 `get_book` 一次返回整本书，大书（如《悉达多》56K 字）会整个吞进 Agent 上下文。现在加了两件事：
1. `get_book` 支持分段参数 `from`/`to`/`limit`，按段落区间取，不再一次吞全文。
2. 新增 `get_toc`（REST: `GET /api/books/:id/toc`，MCP 工具）返回目录/章节索引，Agent 先看目录再选章读。

**向后兼容**：不带 `from`/`to`/`limit` 时 `get_book` 行为和以前完全一样（返回整本 + 全部划线批注）。存量客户端不受影响。

## 第一步：更新代码

```bash
cd /opt/agent-library
git pull origin master
git log --oneline -2   # 应能看到 d4b4a80 大书流式阅读协议
npm install            # 若依赖无变化会自动跳过
```

## 第二步：重启服务

```bash
sudo systemctl restart agent-library
sudo systemctl status agent-library --no-pager | head -n 5   # 确认 running
```

## 第三步：验证旧功能不坏（回归）

```bash
curl -s http://localhost:3000/api/books          # 书架照常返回
curl -s http://localhost:3000/api/books/5        # 若服务器有 id=5：整本返回，且新字段 paragraph_count/from/to/partial 应出现
```

## 第四步：测试新功能（重点）

**4.1 TOC 目录**——用服务器上的《悉达多》（大书）测：

```bash
# 先找大书的 id（word_count 大的那本，比如《悉达多》）
curl -s http://localhost:3000/api/books

# 用找到的 id 测目录（把 <ID> 换成实际 id）
curl -s http://localhost:3000/api/books/<ID>/toc
```

预期：返回 `has_headings`（有标题则为 true）+ `chapters[]` 数组（每章含 title/start_paragraph/end_paragraph/word_count）。若《悉达多》是纯文本无 `#` 标题，会返回单章"全书"、`has_headings=false`——这也是正常结果，如实回报即可。

**4.2 分段读取**：

```bash
# 读前 50 段
curl -s "http://localhost:3000/api/books/<ID>?from=0&limit=50"
# 读中间某区间（如第 100~150 段）
curl -s "http://localhost:3000/api/books/<ID>?from=100&to=151"
```

预期：`paragraph_count` = 全书总段数（两次应一致）、`partial=true`、`content` 只含该区间段落。不带参数时 `partial=false`（整本）。

**4.3 越界保护**：

```bash
curl -s "http://localhost:3000/api/books/<ID>?from=999999"
```

预期：返回 400 `{"error":"from 超出正文范围"}`。

## 第五步：MCP 工具确认

用你的 MCP 客户端 `tools/list`，确认：
- 工具数 31 个
- 有 `get_toc`（参数 book_id, agent_name 可选）
- `get_book` 多了 from/to/limit 可选参数

## 回报格式

1. `git log --oneline -1`（应含 d4b4a80）
2. systemctl 状态（running?）
3. 旧功能回归结果（/api/books、整本 get_book）
4. TOC 测试结果（《悉达多》或大书的 has_headings + 章节数）
5. 分段测试结果（paragraph_count / partial / content 段数）
6. 越界测试结果
7. MCP tools/list 工具数 + get_toc 存在性

有任何异常（报错/返回不对/服务起不来），把错误信息原文贴给我，先不要擅自改代码。
