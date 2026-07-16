#!/usr/bin/env node
/**
 * Content System — serwer: statyczne pliki, auth, SQLite, upload, Bedrock
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  ensureAdminUser,
  ensureBootstrapUsers,
  getSessionUser,
  login,
  logout,
  parseBearerToken
} from "./auth.mjs";
import {
  deletePostForUser,
  getDeletedIds,
  getPostsForUser,
  initDb,
  setDeletedIds,
  upsertPost
} from "./db.mjs";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, "media", "posty");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8"
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8").split("\n").forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  });
}

loadEnvFile();

const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-opus-4-8";

let bedrockClient = null;
try {
  bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
} catch (err) {
  console.warn("Bedrock client init skipped:", err.message);
}

function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function safeFilename(name) {
  const base = path.basename(name || "grafika.jpg")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const ext = path.extname(base).slice(1).toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp"]);
  if (!allowed.has(ext)) {
    throw new Error("Dozwolone formaty: JPG, PNG, WEBP");
  }
  return base || "grafika.jpg";
}

function cors(res, req) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res, req, status, data) {
  cors(res, req);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function requireAuth(req, res) {
  const token = parseBearerToken(req);
  const user = getSessionUser(token);
  if (!user) {
    json(res, req, 401, { error: "Wymagane logowanie" });
    return null;
  }
  return { token, user };
}

function saveUploadedImage({ filename, data }) {
  ensureMediaDir();
  if (!data) throw new Error("Brak danych grafiki");
  const safe = safeFilename(filename);
  const unique = Date.now() + "-" + safe;
  const fullPath = path.join(MEDIA_DIR, unique);
  const buf = Buffer.from(data, "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("Plik za duży (max 8 MB)");
  fs.writeFileSync(fullPath, buf);
  return { path: "media/posty/" + unique, filename: unique };
}

function isAnthropicModel(modelId) {
  return modelId.includes("anthropic.");
}

function parseBedrockText(modelId, rawBody) {
  const parsed = JSON.parse(new TextDecoder().decode(rawBody));
  if (isAnthropicModel(modelId)) {
    return (parsed.content && parsed.content[0] && parsed.content[0].text) || "";
  }
  if (modelId.startsWith("amazon.nova")) {
    const msg = parsed.output && parsed.output.message;
    if (msg && msg.content && msg.content[0]) return msg.content[0].text || "";
  }
  if (parsed.results && parsed.results[0] && parsed.results[0].outputText) {
    return parsed.results[0].outputText;
  }
  if (parsed.generation) return parsed.generation;
  return parsed.outputText || parsed.completion || "";
}

async function invokeBedrock({ system, prompt, maxTokens }) {
  if (!bedrockClient) throw new Error("Bedrock niedostępny — sprawdź AWS credentials i region");

  const modelId = BEDROCK_MODEL_ID;
  let body;

  if (isAnthropicModel(modelId)) {
    body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens || 4096,
      system: system || "",
      messages: [{ role: "user", content: prompt }]
    });
  } else if (modelId.startsWith("amazon.nova")) {
    body = JSON.stringify({
      schemaVersion: "messages-v1",
      messages: [{
        role: "user",
        content: [{ text: (system ? system + "\n\n" : "") + prompt }]
      }],
      inferenceConfig: {
        maxTokens: maxTokens || 4096,
        temperature: 0.2
      }
    });
  } else {
    body = JSON.stringify({
      inputText: (system ? system + "\n\n" : "") + prompt,
      textGenerationConfig: {
        maxTokenCount: maxTokens || 4096,
        temperature: 0.2
      }
    });
  }

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body
  });

  const response = await bedrockClient.send(command);
  return parseBedrockText(modelId, response.body).trim();
}

async function translateText({ text, sourceLang, targetLang }) {
  const src = sourceLang || "en";
  const tgt = targetLang || "pl";
  const system =
    "You are a professional translator for IT and cloud industry content. " +
    "Return ONLY the translated text, without quotes or commentary.";
  const prompt = "Translate from " + src + " to " + tgt + ":\n\n" + text;
  return invokeBedrock({ system, prompt, maxTokens: 4096 });
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.normalize(path.join(__dirname, rel));
  if (!resolved.startsWith(__dirname)) return null;
  return resolved;
}

function serveStatic(req, res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  cors(res, req);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/health") {
      return json(res, req, 200, {
        ok: true,
        service: "content-system-server",
        upload: true,
        bedrock: !!bedrockClient,
        auth: true,
        store: "json",
        region: AWS_REGION,
        model: BEDROCK_MODEL_ID
      });
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === "/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const result = login(body.username, body.password);
      if (!result) return json(res, req, 401, { error: "Nieprawidłowy login lub hasło" });
      return json(res, req, 200, result);
    }

    if (pathname === "/auth/logout" && req.method === "POST") {
      logout(parseBearerToken(req));
      return json(res, req, 200, { ok: true });
    }

    if (pathname === "/auth/me" && req.method === "GET") {
      const user = getSessionUser(parseBearerToken(req));
      if (!user) return json(res, req, 401, { error: "Niezalogowany" });
      return json(res, req, 200, { user });
    }

    if (pathname === "/api/posts" && req.method === "GET") {
      const auth = requireAuth(req, res);
      if (!auth) return;
      return json(res, req, 200, {
        posts: getPostsForUser(auth.user.id),
        deletedIds: getDeletedIds(auth.user.id)
      });
    }

    if (pathname === "/api/posts" && req.method === "PUT") {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const body = await readBody(req);
      const post = body.post || body;
      if (!post || !post.id) return json(res, req, 400, { error: "Brak post.id" });
      upsertPost(auth.user.id, post);
      return json(res, req, 200, { ok: true, post });
    }

    if (pathname.startsWith("/api/posts/") && req.method === "DELETE") {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const postId = decodeURIComponent(pathname.slice("/api/posts/".length));
      deletePostForUser(auth.user.id, postId);
      return json(res, req, 200, { ok: true });
    }

    if (pathname === "/api/deleted-ids" && req.method === "PUT") {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const body = await readBody(req);
      setDeletedIds(auth.user.id, body.deletedIds || []);
      return json(res, req, 200, { ok: true });
    }

    const protectedApi =
      pathname.startsWith("/upload/") ||
      pathname.startsWith("/ai/") ||
      pathname.startsWith("/api/");

    if (protectedApi) {
      const auth = requireAuth(req, res);
      if (!auth) return;

      if (req.method === "POST" && pathname === "/upload/image") {
        const body = await readBody(req);
        const result = saveUploadedImage(body);
        return json(res, req, 200, result);
      }

      if (req.method === "POST" && pathname === "/ai/translate") {
        const body = await readBody(req);
        const text = (body.text || "").trim();
        if (!text) return json(res, req, 400, { error: "Brak pola text" });
        const translated = await translateText({
          text,
          sourceLang: body.sourceLang || "en",
          targetLang: body.targetLang || "pl"
        });
        return json(res, req, 200, { text: translated, provider: "bedrock" });
      }

      if (req.method === "POST" && pathname === "/ai/complete") {
        const body = await readBody(req);
        const prompt = (body.prompt || "").trim();
        if (!prompt) return json(res, req, 400, { error: "Brak pola prompt" });
        const result = await invokeBedrock({
          system: body.system || "",
          prompt,
          maxTokens: body.maxTokens || 4096
        });
        return json(res, req, 200, { text: result, provider: "bedrock" });
      }

      return json(res, req, 404, { error: "Not found" });
    }

    if (req.method === "GET") {
      let filePath = safeStaticPath(pathname);
      if (filePath && serveStatic(req, res, filePath)) return;
      if (pathname === "/" || !path.extname(pathname)) {
        filePath = safeStaticPath("/index.html");
        if (filePath && serveStatic(req, res, filePath)) return;
      }
      return json(res, req, 404, { error: "Not found" });
    }

    json(res, req, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    json(res, req, 500, { error: err.message || "Server error" });
  }
});

try {
  await initDb();
  ensureAdminUser();
  ensureBootstrapUsers();
} catch (err) {
  console.error("WARN — baza danych:", err.message, "— serwer startuje bez auth DB");
}

const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Content System server → http://${HOST}:${PORT}`);
  console.log("Panel + API + auth (JSON store)");
  console.log("Bedrock:", bedrockClient ? BEDROCK_MODEL_ID + " @ " + AWS_REGION : "wyłączony");
});

process.on("uncaughtException", function (err) {
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", function (err) {
  console.error("unhandledRejection:", err);
});
