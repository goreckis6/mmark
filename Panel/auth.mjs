import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  countUsers,
  createSession,
  createUser,
  deleteSession,
  findSession,
  findUserByUsername
} from "./db.mjs";

const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const salt = Buffer.from(parts[0], "hex");
  const hash = Buffer.from(parts[1], "hex");
  const test = scryptSync(password, salt, 64);
  if (hash.length !== test.length) return false;
  return timingSafeEqual(hash, test);
}

export function createToken() {
  return randomBytes(32).toString("hex");
}

export function sessionExpiryIso() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function ensureAdminUser() {
  if (countUsers() > 0) return null;
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = process.env.ADMIN_PASSWORD || "admin123";
  if (!username || !password) {
    throw new Error("Brak użytkowników — ustaw ADMIN_USERNAME i ADMIN_PASSWORD w .env");
  }
  createUser(username, hashPassword(password));
  console.log("Utworzono konto admin:", username, "(zmień hasło po pierwszym logowaniu)");
  return username;
}

/** Tworzy konta z env BOOTSTRAP_USERS=user:haslo,user2:haslo2 (tylko jeśli login nie istnieje) */
export function ensureBootstrapUsers() {
  const raw = process.env.BOOTSTRAP_USERS || "";
  if (!raw.trim()) return;
  raw.split(",").forEach(function (pair) {
    const trimmed = pair.trim();
    if (!trimmed) return;
    const colon = trimmed.indexOf(":");
    if (colon === -1) return;
    const username = trimmed.slice(0, colon).trim();
    const password = trimmed.slice(colon + 1);
    if (!username || !password) return;
    if (findUserByUsername(username)) return;
    createUser(username, hashPassword(password));
    console.log("Utworzono konto (bootstrap):", username);
  });
}

export function login(username, password) {
  const user = findUserByUsername((username || "").trim());
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    return null;
  }
  const token = createToken();
  createSession(token, user.id, sessionExpiryIso());
  return {
    token,
    user: { id: user.id, username: user.username }
  };
}

export function logout(token) {
  if (token) deleteSession(token);
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = findSession(token);
  if (!session) return null;
  return { id: session.user_id, username: session.username };
}

export function parseBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
