import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  word_count  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES agents(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL DEFAULT 'book',
  series_id   INTEGER,
  view_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  source      TEXT,
  source_id   TEXT
);

CREATE TABLE IF NOT EXISTS progress (
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  paragraph   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, agent_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  paragraph   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'yellow',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  paragraph   INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  password    TEXT,
  email       TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  agent_id    INTEGER REFERENCES agents(id),
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id),
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  rating      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  agent_id    INTEGER REFERENCES agents(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, agent_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  from_agent_id INTEGER REFERENCES agents(id),
  book_id     INTEGER REFERENCES books(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  origin_type TEXT,
  origin_id   INTEGER,
  content     TEXT NOT NULL DEFAULT '',
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

ensureColumn("highlights", "agent_id", "INTEGER REFERENCES agents(id)");
ensureColumn("notes", "agent_id", "INTEGER REFERENCES agents(id)");
ensureColumn("highlights", "start_char", "INTEGER");
ensureColumn("highlights", "end_char", "INTEGER");
ensureColumn("notes", "start_char", "INTEGER");
ensureColumn("notes", "end_char", "INTEGER");
ensureColumn("notifications", "origin_type", "TEXT");
ensureColumn("notifications", "origin_id", "INTEGER");
ensureColumn("agents", "password", "TEXT");

// progress 表迁移：旧结构是 book_id 单列主键（无 agent_id，全局共享进度）
// 新结构是 (book_id, agent_id) 复合主键（每用户独立进度）
// 旧表存在且无 agent_id 列 → 重建，旧数据归 agent_id=NULL（匿名/全局）
{
  const cols = db.prepare("PRAGMA table_info(progress)").all();
  const hasAgentId = cols.some((c) => c.name === "agent_id");
  const pkColumns = cols.filter((c) => c.pk > 0).map((c) => c.name);
  const isOld = !hasAgentId && pkColumns.length === 1 && pkColumns[0] === "book_id";
  if (isOld) {
    db.exec(`
      CREATE TABLE progress_new (
        book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        paragraph   INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (book_id, agent_id)
      );
      INSERT INTO progress_new (book_id, agent_id, paragraph, updated_at)
        SELECT book_id, NULL, paragraph, updated_at FROM progress;
      DROP TABLE progress;
      ALTER TABLE progress_new RENAME TO progress;
    `);
    console.log("progress 表已迁移：book_id 单主键 → (book_id, agent_id) 复合主键");
  }
}

// 兜底：表达式唯一索引让 agent_id=NULL（匿名）也参与唯一性
// COALESCE(agent_id, 0)：真实 agent_id 从 1 开始，0 不会冲突
// 建索引前先幂等去重：按 (book_id, COALESCE(agent_id,0)) 分组，每组只保留 rowid 最大的一行
// 防止历史脏数据（重复的匿名进度）导致建索引失败、服务起不来
db.exec(`
  DELETE FROM progress
  WHERE rowid NOT IN (
    SELECT MAX(rowid)
    FROM progress
    GROUP BY book_id, COALESCE(agent_id, 0)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_book_agent
    ON progress (book_id, COALESCE(agent_id, 0));
`);

// agents.is_admin 迁移 + 管理员标记
// 环境变量 AGENT_LIBRARY_ADMIN：逗号分隔的管理员身份名列表，启动时自动标记为 is_admin=1
ensureColumn("agents", "is_admin", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("agents", "email", "TEXT");
ensureColumn("books", "created_by", "INTEGER REFERENCES agents(id)");
{
  const adminNames = (process.env.AGENT_LIBRARY_ADMIN || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of adminNames) {
    const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(name);
    if (existing) {
      db.prepare("UPDATE agents SET is_admin = 1 WHERE id = ?").run(existing.id);
    } else {
      db.prepare("INSERT INTO agents (name, is_admin) VALUES (?, 1)").run(name);
    }
  }
  if (adminNames.length) console.log(`管理员已标记: ${adminNames.join(", ")}`);
}
// ---------- P2 版本化迁移（user_version） ----------
// 现有 ensureColumn 等一次性迁移保持原样（已验证幂等，不动它们）。
// P2 新增的表/字段统一走这里：migrations 数组按版本递增，user_version 记录已执行到哪版。
// 每次启动 migrate() 自动补执行未跑的版本，保证新增列/表幂等、可追溯。
// 注意：新列已写进 books 的 CREATE TABLE 定义（全新库一步到位），migrations 只负责老库补列，用 ensureColumn 幂等。

function ensureBooksP2Columns() {
  ensureColumn("books", "kind", "TEXT NOT NULL DEFAULT 'book'");
  ensureColumn("books", "series_id", "INTEGER");
  ensureColumn("books", "view_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("books", "updated_at", "TEXT");
}

const migrations = [
  {
    version: 1,
    run: () => {
      ensureBooksP2Columns(); // 老库补 P2 列（幂等）
      db.exec(`
        -- P2 订阅
        CREATE TABLE IF NOT EXISTS subscriptions (
          author_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          reader_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (author_id, reader_id)
        );
      `);
    },
  },
  {
    version: 2,
    run: () => {
      // 微信读书同步：books.source/source_id 标识来源，highlights/notes.source_id 去重
      ensureColumn("books", "source", "TEXT");
      ensureColumn("books", "source_id", "TEXT");
      ensureColumn("highlights", "source_id", "TEXT");
      ensureColumn("notes", "source_id", "TEXT");
      // 唯一索引防重复同步（同书同微信笔记只一条）
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_source ON highlights (source_id) WHERE source_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_source ON notes (source_id) WHERE source_id IS NOT NULL;
      `);
    },
  },
  {
    version: 3,
    run: () => {
      // 每个用户自己的微信读书 key（per-user，避免全局共享导致隐私泄露）
      ensureColumn("agents", "weread_api_key", "TEXT");
    },
  },
  {
    version: 4,
    run: () => {
      // 微信书评同步去重
      ensureColumn("reviews", "source_id", "TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_source ON reviews (source_id) WHERE source_id IS NOT NULL;
      `);
    },
  },
  {
    version: 5,
    run: () => {
      // 关注推送：follows.content_types = 关注者想接收的对方内容类型（JSON数组，空=全部）
      ensureColumn("follows", "content_types", "TEXT");
    },
  },
  {
    version: 6,
    run: () => {
      // 审计：注册接口记 IP
      ensureColumn("agents", "registered_ip", "TEXT");
    },
  },
  {
    version: 7,
    run: () => {
      // 消息归档：archived=1 的消息即使已读也不再显示在收件箱列表
      ensureColumn("notifications", "archived", "INTEGER NOT NULL DEFAULT 0");
    },
  },
];

function migrate() {
  let v = db.pragma("user_version", { simple: true });
  for (const m of migrations) {
    if (m.version > v) {
      db.transaction(() => {
        m.run();
        db.pragma(`user_version = ${m.version}`);
      })();
      console.log(`迁移到版本 ${m.version}`);
    }
  }
}
migrate();

export default db;
