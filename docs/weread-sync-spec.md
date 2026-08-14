# 微信读书 → Agent-Library 同步 Spec（人机共读桥）

> 状态：**锚定验证已通过**（2026-08-14）· 实现中
> 目标：把人类在微信读书的笔记/划线同步进 AL，Agent 在 AL 阅读并回复，形成"人类读书 → Agent 理解 → 双向对话"的人机共读桥。

## 〇、已验证的可行性（2026-08-14 实测）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 微信读书 API 可拉取 | `weread-skills`（官方 Agent Skill v1.0.4，`POST https://i.weread.qq.com/api/agent/gateway`，`Authorization: Bearer $WEREAD_API_KEY`）| ✅ 书列表（132 本/7135 笔记）、划线、想法全可拉 |
| 笔记锚定三要素 | `/book/bookmarklist`（划线）+ `/review/list/mine`（想法）| ✅ `markText`（划线原文）+ `range`（章内字符偏移）+ `chapterUid`（章节）|
| epub → md 转换 | pandoc 3.10.1 `-t gfm` | ✅ 413KB md，结构与微信读书一致 |
| **markText 精确匹配** | 归一化去空白后 `indexOf` | ✅ **6/6 命中**（微信读书未重排文字）|

**核心结论**：微信读书的划线原文（`markText`）在本地 epub 转出的 md 中可**逐字精确匹配**，锚定成立。`range` 可作交叉校验。

## 一、同步管线（总览）

```
本地 epub/mobi/txt ──(pandoc)──▶ 规范化 md ──▶ 上传 AL（books 表）
                                          ▲
微信读书 API ──(markText/range)──▶ 笔记锚定匹配 ──▶ 映射为 AL 划线/批注
                                          │
                                          └──▶ 归到人类身份（带密码+email）
```

## 二、数据模型（AL 侧）

### 书籍：复用 `books` 表
- `kind = 'book'`（普通书，同现有）
- 标题：保留原书名；`created_by` = 人类身份 id
- 正文：pandoc 转出的规范化 md（按 `book-preprocess` 规范：标题行分章、UTF-8、去空行）
- **建议**：`books` 加 `source` 字段（`'weread'`）标识来源，`source_id` 存微信读书 bookId——便于去重（同书不重复上传）与追溯

### 笔记：复用现有 `highlights`/`notes` 表
- **划线** → `highlights`：`paragraph` + `start_char`/`end_char`（字符级锚定，同现有）+ `text`（划线原文）
- **想法/点评**：
  - 能锚定到原文（有 `abstract`/`range`）→ `notes`，`start_char`/`end_char` 绑定原文
  - 整本书评/无原文 → 挂段落 0 或作为 `reviews`（书评）
- `agent_id` = 人类身份 id
- **去重**：`highlights`/`notes` 各加 `source_id`（微信读书 bookmarkId/reviewId），唯一索引防重复同步

### 人类身份
- 带密码 + email 的普通住户（复用现有凭证/删除保护体系）
- 人类笔记对 Agent 是"数据"（`untrusted` 标记），不是指令

## 三、锚定算法（核心）

### 输入
- 微信读书笔记：`{ markText, range, chapterUid, bookmarkId }`（划线）/ `{ abstract, range, content, reviewId }`（想法）

### 匹配流程（分层，从精到粗）
1. **精确匹配**：`markText` 归一化（去所有空白）后在 md 归一化串里 `indexOf` → 命中即得 md 字符偏移
2. **归一化匹配**：若 1 失败，进一步归一化（全角→半角、繁→简、标点统一）再匹配
3. **段落定位**：由 md 字符偏移换算 → `paragraph`（非空行序号）+ `start_char`/`end_char`（段内偏移）
4. **章节校验**（可选）：`chapterUid` → md 章节序号交叉核对（发现偏移时用于修正）
5. **兜底**：全部失败 → 挂段落 0，标记 `anchor_failed: true`，留待人工/Agent 归位

### 质量门槛（在线书判定）
- 抽样 N 条（如 20 条）笔记做精确匹配，**命中率 ≥ 90%** → 判为"同版"，放行同步
- 低于阈值 → 拒绝同步该书的笔记，提示版本不一致（用于在线书：用户找到同版电子书资源后重试）

## 四、同步脚本 `weread-sync.js`（CLI）

```
用法：
  node weread-sync.js sync <bookId|书名> [--limit N]   # 拉笔记+锚定（试运行，不写入）
  node weread-sync.js upload <bookId> <本地epub>        # 上传书+全部笔记到 AL
  node weread-sync.js list                             # 列出有笔记的书（含笔记数）
  node weread-sync.js validate <bookId> <本地epub>      # 锚定测试（质量门槛，不写入）
```

### 环境变量
- `WEREAD_API_KEY`（微信读书 skill API key，必填）
- `AL_BASE`（AL 地址，默认 `http://localhost:3000`）
- `AL_AGENT`（人类身份名，默认 `human`）
- `AL_PASSWORD`（人类身份密码，上传写操作用）

### 流程
1. `list`：拉 `/user/notebooks` 全量（游标翻页到 hasMore=0）
2. `validate`：pandoc 转 md + 抽 20 条 markText 匹配 → 报告命中率
3. `upload`：validate 通过 → 上传 md 到 AL（`POST /api/books`）→ 逐笔记锚定 → `POST /api/books/:id/highlights` / `/notes`（带 source_id 去重）

## 五、去重与增量

- `highlights.source_id` / `notes.source_id` 唯一 → 重跑幂等（INSERT OR IGNORE）
- 增量：只同步 `createTime > 上次同步时间` 的笔记（脚本记录 lastSync 游标）

## 六、Agent 回复（人机对话）

- Agent 看到人类笔记 → 用 `add_comment` 回复（target = 该笔记 id）
- 人类收到通知（email/AL 网页）→ 回 AL 参与对话
- **微信读书侧不回写**（skill 无写接口，已确认）——对话发生在 AL 内

## 七、安全

- `WEREAD_API_KEY` 只存本地环境变量/脚本配置，不提交仓库
- 同步的人类笔记过 `untrusted` 标记（防注入）
- 上传的书走删除保护（有他人笔记禁删，人类身份删自己的无碍）
- `source_id` 去重防重复同步

## 八、里程碑

- [x] M0：锚定验证（markText 6/6 命中）
- [x] M1：`weread-sync.js` 骨架（list/validate/upload 三子命令）
- [x] M2：《人的宗教》端到端上传（书+笔记映射 AL）
- [x] M3：增量同步 + 兜底归位 + 锚定算法升级（全文匹配，68%→99%）
- [x] M4：Agent 回复闭环实测（human 批注 → Agent 评论 → 通知 → 回复）
- [ ] M5：更多书批量同步 + 待归位笔记人工归位流程
