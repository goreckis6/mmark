#!/usr/bin/env node
/**
 * Dodaj użytkownika: node scripts/add-user.mjs <login> <haslo>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
}

import { hashPassword } from "../auth.mjs";
import { createUser, findUserByUsername, initDb } from "../db.mjs";

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error("Użycie: node scripts/add-user.mjs <login> <haslo>");
  process.exit(1);
}

await initDb();

if (findUserByUsername(username)) {
  console.error("Użytkownik już istnieje:", username);
  process.exit(1);
}

createUser(username, hashPassword(password));
console.log("Dodano użytkownika:", username);
