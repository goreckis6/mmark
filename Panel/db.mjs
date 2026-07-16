import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const EMPTY_STORE = {
  users: [],
  sessions: [],
  posts: [],
  settings: []
};

let store = null;

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    store = JSON.parse(JSON.stringify(EMPTY_STORE));
    persistStore();
    return store;
  }
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {
    store = JSON.parse(JSON.stringify(EMPTY_STORE));
    persistStore();
  }
  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.sessions)) store.sessions = [];
  if (!Array.isArray(store.posts)) store.posts = [];
  if (!Array.isArray(store.settings)) store.settings = [];
  return store;
}

function persistStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function initDb() {
  loadStore();
  return store;
}

export function getDb() {
  if (!store) loadStore();
  return store;
}

function nextUserId() {
  var max = 0;
  store.users.forEach(function (u) {
    if (u.id > max) max = u.id;
  });
  return max + 1;
}

export function countUsers() {
  return getDb().users.length;
}

export function findUserByUsername(username) {
  var q = (username || "").toLowerCase();
  return getDb().users.find(function (u) {
    return (u.username || "").toLowerCase() === q;
  }) || null;
}

export function createUser(username, passwordHash) {
  var id = nextUserId();
  getDb().users.push({
    id: id,
    username: username,
    password_hash: passwordHash,
    created_at: new Date().toISOString()
  });
  persistStore();
  return id;
}

export function createSession(token, userId, expiresAt) {
  getDb().sessions.push({ token: token, user_id: userId, expires_at: expiresAt });
  persistStore();
}

export function findSession(token) {
  purgeExpiredSessions();
  var s = getDb().sessions.find(function (x) { return x.token === token; });
  if (!s) return null;
  var user = getDb().users.find(function (u) { return u.id === s.user_id; });
  if (!user) return null;
  return {
    token: s.token,
    user_id: s.user_id,
    expires_at: s.expires_at,
    username: user.username
  };
}

export function deleteSession(token) {
  getDb().sessions = getDb().sessions.filter(function (s) { return s.token !== token; });
  persistStore();
}

export function purgeExpiredSessions() {
  var now = new Date().toISOString().slice(0, 19).replace("T", " ");
  getDb().sessions = getDb().sessions.filter(function (s) {
    return s.expires_at > now;
  });
  persistStore();
}

export function getPostsForUser(userId) {
  return getDb().posts
    .filter(function (p) { return p.user_id === userId; })
    .sort(function (a, b) {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    })
    .map(function (p) {
      try { return JSON.parse(p.data); }
      catch (e) { return null; }
    })
    .filter(Boolean);
}

export function upsertPost(userId, post) {
  var data = JSON.stringify(post);
  var now = new Date().toISOString();
  var existing = getDb().posts.find(function (p) {
    return p.user_id === userId && p.id === post.id;
  });
  if (existing) {
    existing.data = data;
    existing.updated_at = now;
  } else {
    getDb().posts.push({
      id: post.id,
      user_id: userId,
      data: data,
      updated_at: now
    });
  }
  persistStore();
}

export function deletePostForUser(userId, postId) {
  getDb().posts = getDb().posts.filter(function (p) {
    return !(p.user_id === userId && p.id === postId);
  });
  persistStore();
}

export function replacePostsForUser(userId, posts) {
  getDb().posts = getDb().posts.filter(function (p) { return p.user_id !== userId; });
  var now = new Date().toISOString();
  posts.forEach(function (post) {
    getDb().posts.push({
      id: post.id,
      user_id: userId,
      data: JSON.stringify(post),
      updated_at: now
    });
  });
  persistStore();
}

export function getDeletedIds(userId) {
  var row = getDb().settings.find(function (s) { return s.user_id === userId; });
  if (!row) return [];
  try {
    var parsed = JSON.parse(row.deleted_ids || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function setDeletedIds(userId, ids) {
  var row = getDb().settings.find(function (s) { return s.user_id === userId; });
  var payload = JSON.stringify(ids || []);
  if (row) {
    row.deleted_ids = payload;
  } else {
    getDb().settings.push({ user_id: userId, deleted_ids: payload });
  }
  persistStore();
}
