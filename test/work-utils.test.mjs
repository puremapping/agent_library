import { test } from "node:test";
import assert from "node:assert/strict";
import db from "../db.js";
import { insertWork, findSerialShell, createSerial, addSerialChapter, listSerial, getWorkBook, subscribe, unsubscribe, listSubscribers, listSubscriptions, notifySubscribers, authorDashboard, trackView } from "../work-utils.js";

// work-utils 直接用全局 db。用事务包裹每次测试 + 回滚，避免污染真实数据。
function withRollback(fn) {
  db.exec("BEGIN");
  try {
    fn();
  } finally {
    db.exec("ROLLBACK");
  }
}

test("insertWork: 短篇 kind=work, series_id=NULL", () => {
  withRollback(() => {
    const id = insertWork("短篇", "# 头\n正文。", null, "work", null);
    const b = getWorkBook(id);
    assert.equal(b.kind, "work");
    assert.equal(b.series_id, null);
    assert.equal(b.word_count, 5); // "#头正文。" 去空白 5 字
  });
});

test("createSerial + addSerialChapter: 连载语义", () => {
  withRollback(() => {
    const seriesId = createSerial("连载", null);
    const shell = findSerialShell(seriesId);
    assert.ok(shell, "壳书存在");
    assert.equal(shell.kind, "serial");
    assert.equal(shell.content, "", "壳书内容为空");

    const c1 = addSerialChapter(seriesId, "第一章", "第一章正文。", null);
    const c2 = addSerialChapter(seriesId, null, "第二章正文。", null); // 缺省标题
    const b1 = getWorkBook(c1);
    assert.equal(b1.kind, "serial");
    assert.equal(b1.series_id, seriesId);
    assert.equal(b1.title, "第一章");

    const list = listSerial(seriesId);
    assert.equal(list.chapters.length, 2);
    assert.equal(list.chapters[0].title, "第一章");
    assert.equal(list.chapters[1].title, "第2章"); // 缺省自动编号（c1 已占第1章）
  });
});

test("addSerialChapter: 缺省标题自动编号随章节数", () => {
  withRollback(() => {
    const seriesId = createSerial("连载2", null);
    const c1 = addSerialChapter(seriesId, "序章", "x", null);
    const c2 = addSerialChapter(seriesId, null, "y", null);
    assert.equal(getWorkBook(c2).title, "第2章"); // count=1（壳书不算）+1=2
  });
});

test("listSerial: 不存在的连载返回 null", () => {
  assert.equal(listSerial(999999), null);
});

test("findSerialShell: 非 serial 的书返回 undefined", () => {
  withRollback(() => {
    const id = insertWork("普通书", "内容", null, "book", null);
    assert.equal(findSerialShell(id), undefined);
  });
});

// ---------- 订阅（P2 里程碑 2） ----------
function fakeAgent(name) {
  return db.prepare("INSERT INTO agents (name) VALUES (?)").run(name).lastInsertRowid;
}

test("subscribe: 幂等 + 不能订阅自己", () => {
  withRollback(() => {
    const author = fakeAgent("订阅测试作者");
    const reader = fakeAgent("订阅测试读者");
    const r1 = subscribe(reader, author);
    assert.equal(r1.subscribed, true);
    const r2 = subscribe(reader, author);
    assert.equal(r2.already_subscribed, true); // 幂等
    assert.equal(subscribe(reader, reader).error, "不能订阅自己");
  });
});

test("subscribe/unsubscribe: 两表独立（不碰 follows）", () => {
  withRollback(() => {
    const author = fakeAgent("订阅独立作者");
    const reader = fakeAgent("订阅独立读者");
    // 先建 follows 关系
    db.prepare("INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)").run(reader, author);
    subscribe(reader, author);
    const f1 = db.prepare("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?").get(reader, author);
    assert.ok(f1, "follows 仍在");
    const un = unsubscribe(reader, author);
    assert.equal(un.unsubscribed, true);
    const f2 = db.prepare("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?").get(reader, author);
    assert.ok(f2, "取消订阅不误删 follows");
  });
});

test("notifySubscribers: 发追更通知 + 防风暴查重", () => {
  withRollback(() => {
    const author = fakeAgent("追更作者");
    const reader = fakeAgent("追更读者");
    subscribe(reader, author);
    const seriesId = createSerial("追更连载", author);
    const chapterId = addSerialChapter(seriesId, "第一章", "正文", author);

    const notifs = [];
    // 真实写入 notifications 表（查重依赖真实库），同时记录到数组
    const fakeNotif = (o) => {
      notifs.push(o);
      db.prepare(
        `INSERT INTO notifications (agent_id, type, from_agent_id, book_id, target_type, target_id, origin_type, origin_id, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(o.agentId, o.type, o.fromAgentId ?? null, o.bookId ?? null, o.targetType, o.targetId, o.originType ?? null, o.originId ?? null, o.content ?? "");
    };

    const n1 = notifySubscribers(seriesId, chapterId, "第一章", author, fakeNotif);
    assert.equal(n1, 1, "一个订阅者收到 1 条");
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0].type, "update");
    assert.equal(notifs[0].agentId, reader);
    assert.equal(notifs[0].bookId, chapterId);
    assert.ok(notifs[0].content.includes("追更连载"), "通知含书名");

    // 防风暴：对同一章再调一次 → 不新增
    const n2 = notifySubscribers(seriesId, chapterId, "第一章", author, fakeNotif);
    assert.equal(n2, 0, "同章查重，不再通知");
    assert.equal(notifs.length, 1, "通知总数不变");

    // 新章 → 新通知
    const chapterId2 = addSerialChapter(seriesId, "第二章", "正文2", author);
    const n3 = notifySubscribers(seriesId, chapterId2, "第二章", author, fakeNotif);
    assert.equal(n3, 1);
    assert.equal(notifs.length, 2);
  });
});

test("listSubscribers/listSubscriptions: 双向查询", () => {
  withRollback(() => {
    const author = fakeAgent("列表作者");
    const reader = fakeAgent("列表读者");
    subscribe(reader, author);
    const subs = listSubscribers(author);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, reader);
    const mySubs = listSubscriptions(reader);
    assert.equal(mySubs.length, 1);
    assert.equal(mySubs[0].id, author);
  });
});

// ---------- 作者面板 + 阅读量（P2 里程碑 3） ----------
test("trackView: 首次打开 +1，重复打开去重", () => {
  withRollback(() => {
    const author = fakeAgent("面板作者");
    const reader = fakeAgent("面板读者");
    const workId = insertWork("面板短篇", "正文", author, "work", null);
    assert.equal(trackView(workId, reader), true, "首次打开计 1 次");
    assert.equal(trackView(workId, reader), false, "重复打开不计");
    const b = getWorkBook(workId);
    assert.equal(b.view_count, 1);
  });
});

test("trackView: 无身份不计", () => {
  withRollback(() => {
    const workId = insertWork("匿名面板短篇", "正文", null, "work", null);
    assert.equal(trackView(workId, null), false);
    assert.equal(getWorkBook(workId).view_count, 0);
  });
});

test("authorDashboard: 短篇+连载聚合 + 订阅数 + 反馈", () => {
  withRollback(() => {
    const author = fakeAgent("面板作者2");
    const reader = fakeAgent("面板读者2");
    // 短篇 + 连载(2章)
    const workId = insertWork("面板短篇2", "正文", author, "work", null);
    const seriesId = createSerial("面板连载2", author);
    const c1 = addSerialChapter(seriesId, "第1章", "正文1", author);
    const c2 = addSerialChapter(seriesId, "第2章", "正文2", author);
    // 读者看两章
    trackView(c1, reader);
    trackView(c2, reader);
    // 读者订阅
    subscribe(reader, author);
    // 读者在短篇写书评
    db.prepare("INSERT INTO reviews (book_id, agent_id, content, rating) VALUES (?, ?, ?, ?)").run(workId, reader, "好看", 5);
    // 读者评论短篇的批注
    const noteId = db.prepare("INSERT INTO notes (book_id, agent_id, paragraph, content) VALUES (?, ?, 0, '批注')").run(workId, reader).lastInsertRowid;
    db.prepare("INSERT INTO comments (book_id, target_type, target_id, agent_id, content) VALUES (?, 'note', ?, ?, '评论批注')").run(workId, noteId, reader);

    const dash = authorDashboard(author);
    assert.equal(dash.subscription_count, 1);
    assert.equal(dash.works.length, 2, "短篇+连载各一");
    const serial = dash.works.find((x) => x.title === "面板连载2");
    assert.equal(serial.chapter_count, 2);
    assert.equal(serial.total_views, 2);
    const work = dash.works.find((x) => x.title === "面板短篇2");
    assert.equal(work.review_count, 1);
    assert.equal(work.comment_count, 1);
    assert.ok(dash.recent_reviews.some((r) => r.content === "好看"), "书评 content 字段有值");
    assert.ok(dash.recent_comments.some((c) => c.content === "评论批注"));
  });
});
