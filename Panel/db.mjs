import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, "content-system.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      deleted_ids TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}

export function countUsers() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

export function findUserByUsername(username) {
  return getDb().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
}

export function createUser(username, passwordHash) {
  const info = getDb()
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(username, passwordHash);
  return info.lastInsertRowid;
}

export function createSession(token, userId, expiresAt) {
  getDb()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, expiresAt);
}

export function findSession(token) {
  purgeExpiredSessions();
  return getDb()
    .prepare(`
      SELECT s.token, s.user_id, s.expires_at, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `)
    .get(token);
}

export function deleteSession(token) {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions() {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

export function getPostsForUser(userId) {
  const rows = getDb()
    .prepare("SELECT data FROM posts WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId);
  return rows.map(function (row) {
    try { return JSON.parse(row.data); }
    catch (e) { return null; }
  }).filter(Boolean);
}

export function upsertPost(userId, post) {
  const data = JSON.stringify(post);
  getDb()
    .prepare(`
      INSERT INTO posts (id, user_id, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, id) DO UPDATE SET
        data = excluded.data,
        updated_at = datetime('now')
    `)
    .run(post.id, userId, data);
}

export function deletePostForUser(userId, postId) {
  getDb().prepare("DELETE FROM posts WHERE user_id = ? AND id = ?").run(userId, postId);
}

export function replacePostsForUser(userId, posts) {
  const database = getDb();
  const tx = database.transaction(function (items) {
    database.prepare("DELETE FROM posts WHERE user_id = ?").run(userId);
    const insert = database.prepare(`
      INSERT INTO posts (id, user_id, data, updated_at) VALUES (?, ?, ?, datetime('now'))
    `);
    items.forEach(function (post) {
      insert.run(post.id, userId, JSON.stringify(post));
    });
  });
  tx(posts);
}

export function getDeletedIds(userId) {
  const row = getDb().prepare("SELECT deleted_ids FROM user_settings WHERE user_id = ?").get(userId);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.deleted_ids);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function setDeletedIds(userId, ids) {
  getDb()
    .prepare(`
      INSERT INTO user_settings (user_id, deleted_ids) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET deleted_ids = excluded.deleted_ids
    `)
    .run(userId, JSON.stringify(ids || []));
}
