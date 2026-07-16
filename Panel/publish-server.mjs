#!/usr/bin/env node
/**
 * Content System — serwer Express: statyczne pliki, auth, upload, Bedrock
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
let bedrockInitFailed = false;

async function getBedrockClient() {
  if (bedrockClient) return bedrockClient;
  if (bedrockInitFailed) return null;
  try {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
    return bedrockClient;
  } catch (err) {
    bedrockInitFailed = true;
    console.warn("Bedrock client init skipped:", err.message);
    return null;
  }
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

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(req, res, status, data) {
  cors(req, res);
  res.status(status).json(data);
}

function requireAuth(req, res) {
  const token = parseBearerToken(req);
  const user = getSessionUser(token);
  if (!user) {
    sendJson(req, res, 401, { error: "Wymagane logowanie" });
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
  const client = await getBedrockClient();
  if (!client) throw new Error("Bedrock niedostępny — sprawdź AWS credentials i region");

  const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
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

  const response = await client.send(command);
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
  cors(req, res);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function createApp() {
  try {
    initDb();
    ensureAdminUser();
    ensureBootstrapUsers();
  } catch (err) {
    console.error("WARN — baza danych:", err.message, "— serwer startuje bez auth DB");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "12mb" }));

  app.use(function (req, res, next) {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Lekki health — bez Bedrock (żeby start/health nie wisiał na AWS)
  app.get("/health", function (req, res) {
    sendJson(req, res, 200, {
      ok: true,
      service: "content-system-server",
      upload: true,
      bedrock: !bedrockInitFailed,
      auth: true,
      store: "json",
      region: AWS_REGION,
      model: BEDROCK_MODEL_ID
    });
  });

  app.get("/favicon.ico", function (_req, res) {
    res.status(204).end();
  });

  app.post("/auth/login", function (req, res) {
    const result = login(req.body.username, req.body.password);
    if (!result) return sendJson(req, res, 401, { error: "Nieprawidłowy login lub hasło" });
    sendJson(req, res, 200, result);
  });

  app.post("/auth/logout", function (req, res) {
    logout(parseBearerToken(req));
    sendJson(req, res, 200, { ok: true });
  });

  app.get("/auth/me", function (req, res) {
    const user = getSessionUser(parseBearerToken(req));
    if (!user) return sendJson(req, res, 401, { error: "Niezalogowany" });
    sendJson(req, res, 200, { user });
  });

  app.get("/api/posts", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(req, res, 200, {
      posts: getPostsForUser(auth.user.id),
      deletedIds: getDeletedIds(auth.user.id)
    });
  });

  app.put("/api/posts", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const post = req.body.post || req.body;
    if (!post || !post.id) return sendJson(req, res, 400, { error: "Brak post.id" });
    upsertPost(auth.user.id, post);
    sendJson(req, res, 200, { ok: true, post });
  });

  app.delete("/api/posts/:postId", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    deletePostForUser(auth.user.id, decodeURIComponent(req.params.postId));
    sendJson(req, res, 200, { ok: true });
  });

  app.put("/api/deleted-ids", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    setDeletedIds(auth.user.id, req.body.deletedIds || []);
    sendJson(req, res, 200, { ok: true });
  });

  app.post("/upload/image", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const result = saveUploadedImage(req.body);
      sendJson(req, res, 200, result);
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || "Upload error" });
    }
  });

  // Proxy news sources (Reddit/Lobsters/dev.to/RSS) — omija CORS i 403 przeglądarki
  const PROXY_HOSTS = new Set([
    "lobste.rs",
    "www.reddit.com",
    "reddit.com",
    "oauth.reddit.com",
    "dev.to",
    "hacker-news.firebaseio.com",
    "feeds.arstechnica.com",
    "www.theregister.com",
    "www.infoworld.com",
    "techcrunch.com",
    "www.zdnet.com",
    "feeds.feedburner.com"
  ]);
  const proxyCache = new Map();

  function isAllowedProxyUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      return PROXY_HOSTS.has(u.hostname.toLowerCase());
    } catch (e) {
      return false;
    }
  }

  app.get("/api/proxy", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const target = String(req.query.url || "").trim();
    if (!target || !isAllowedProxyUrl(target)) {
      return sendJson(req, res, 400, { error: "Niedozwolony URL proxy" });
    }

    const cached = proxyCache.get(target);
    if (cached && cached.expires > Date.now()) {
      res.status(cached.status);
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("X-Proxy-Cache", "HIT");
      return res.end(cached.body);
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          Accept: "application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "User-Agent":
            "Mozilla/5.0 (compatible; ContentSystem/1.0; +https://morphyimg.com) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        },
        redirect: "follow"
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (upstream.ok && buf.length < 2 * 1024 * 1024) {
        proxyCache.set(target, {
          status: upstream.status,
          contentType,
          body: buf,
          expires: Date.now() + 5 * 60 * 1000
        });
        if (proxyCache.size > 80) {
          const first = proxyCache.keys().next().value;
          proxyCache.delete(first);
        }
      }
      res.status(upstream.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Proxy-Cache", "MISS");
      res.end(buf);
    } catch (err) {
      sendJson(req, res, 502, { error: err.message || "Proxy fetch failed" });
    }
  });

  app.post("/ai/translate", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const text = (req.body.text || "").trim();
      if (!text) return sendJson(req, res, 400, { error: "Brak pola text" });
      const translated = await translateText({
        text,
        sourceLang: req.body.sourceLang || "en",
        targetLang: req.body.targetLang || "pl"
      });
      sendJson(req, res, 200, { text: translated, provider: "bedrock" });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || "Server error" });
    }
  });

  app.post("/ai/complete", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const prompt = (req.body.prompt || "").trim();
      if (!prompt) return sendJson(req, res, 400, { error: "Brak pola prompt" });
      const result = await invokeBedrock({
        system: req.body.system || "",
        prompt,
        maxTokens: req.body.maxTokens || 4096
      });
      sendJson(req, res, 200, { text: result, provider: "bedrock" });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || "Server error" });
    }
  });

  app.get("*", function (req, res) {
    let filePath = safeStaticPath(req.path);
    if (filePath && serveStatic(req, res, filePath)) return;
    if (req.path === "/" || !path.extname(req.path)) {
      filePath = safeStaticPath("/index.html");
      if (filePath && serveStatic(req, res, filePath)) return;
    }
    sendJson(req, res, 404, { error: "Not found" });
  });

  return app;
}
