import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "content-system.db");

let db = null;
let savePending = false;

function persistDb() {
  if (!db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function schedulePersist() {
  if (savePending) return;
  savePending = true;
  setImmediate(function () {
    savePending = false;
    persistDb();
  });
}

function run(sql, params) {
  db.run(sql, params || []);
  schedulePersist();
}

function queryOne(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      deleted_ids TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");
  schedulePersist();
}

export async function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let wasmPath;
  try {
    wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  } catch (e) {
    wasmPath = path.join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  }
  if (!fs.existsSync(wasmPath)) {
    throw new Error("Brak sql-wasm.wasm — uruchom npm install w folderze Panel");
  }
  const SQL = await initSqlJs({
    locateFile: function () { return wasmPath; }
  });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA foreign_keys = ON");
  initSchema();
  return db;
}

export function getDb() {
  if (!db) throw new Error("Baza nie zainicjalizowana — wywołaj initDb()");
  return db;
}

export function countUsers() {
  const row = queryOne("SELECT COUNT(*) AS n FROM users");
  return row ? row.n : 0;
}

export function findUserByUsername(username) {
  return queryOne(
    "SELECT * FROM users WHERE lower(username) = lower(?)",
    [username]
  );
}

export function createUser(username, passwordHash) {
  run("INSERT INTO users (username, password_hash) VALUES (?, ?)", [username, passwordHash]);
  const row = queryOne("SELECT last_insert_rowid() AS id");
  return row ? row.id : 0;
}

export function createSession(token, userId, expiresAt) {
  run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, userId, expiresAt]);
}

export function findSession(token) {
  purgeExpiredSessions();
  return queryOne(
    `SELECT s.token, s.user_id, s.expires_at, u.username
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    [token]
  );
}

export function deleteSession(token) {
  run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function purgeExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
}

export function getPostsForUser(userId) {
  const rows = queryAll(
    "SELECT data FROM posts WHERE user_id = ? ORDER BY updated_at DESC",
    [userId]
  );
  return rows.map(function (row) {
    try { return JSON.parse(row.data); }
    catch (e) { return null; }
  }).filter(Boolean);
}

export function upsertPost(userId, post) {
  const data = JSON.stringify(post);
  run(
    `INSERT INTO posts (id, user_id, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, id) DO UPDATE SET
       data = excluded.data,
       updated_at = datetime('now')`,
    [post.id, userId, data]
  );
}

export function deletePostForUser(userId, postId) {
  run("DELETE FROM posts WHERE user_id = ? AND id = ?", [userId, postId]);
}

export function replacePostsForUser(userId, posts) {
  run("DELETE FROM posts WHERE user_id = ?", [userId]);
  posts.forEach(function (post) {
    run(
      "INSERT INTO posts (id, user_id, data, updated_at) VALUES (?, ?, ?, datetime('now'))",
      [post.id, userId, JSON.stringify(post)]
    );
  });
}

export function getDeletedIds(userId) {
  const row = queryOne("SELECT deleted_ids FROM user_settings WHERE user_id = ?", [userId]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.deleted_ids);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function setDeletedIds(userId, ids) {
  run(
    `INSERT INTO user_settings (user_id, deleted_ids) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET deleted_ids = excluded.deleted_ids`,
    [userId, JSON.stringify(ids || [])]
  );
}
