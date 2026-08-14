import { test } from "node:test";
import assert from "node:assert/strict";
import db from "../db.js";
import { insertWork, findSerialShell, createSerial, addSerialChapter, listSerial, getWorkBook } from "../work-utils.js";

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
