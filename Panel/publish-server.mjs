#!/usr/bin/env node
/**
 * Content System — lokalny serwer: upload grafik + proxy AWS Bedrock
 * Uruchom: npm install && npm start
 * Credentials: Panel/.env lub aws configure (profil domyślny)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, "media", "posty");

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

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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
  const prompt =
    "Translate from " + src + " to " + tgt + ":\n\n" + text;
  return invokeBedrock({ system, prompt, maxTokens: 4096 });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "content-system-local-server",
      upload: true,
      bedrock: !!bedrockClient,
      region: AWS_REGION,
      model: BEDROCK_MODEL_ID
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = await readBody(req);

    if (url.pathname === "/upload/image") {
      const result = saveUploadedImage(body);
      return json(res, 200, result);
    }

    if (url.pathname === "/ai/translate") {
      const text = (body.text || "").trim();
      if (!text) return json(res, 400, { error: "Brak pola text" });
      const translated = await translateText({
        text,
        sourceLang: body.sourceLang || "en",
        targetLang: body.targetLang || "pl"
      });
      return json(res, 200, { text: translated, provider: "bedrock" });
    }

    if (url.pathname === "/ai/complete") {
      const prompt = (body.prompt || "").trim();
      if (!prompt) return json(res, 400, { error: "Brak pola prompt" });
      const result = await invokeBedrock({
        system: body.system || "",
        prompt,
        maxTokens: body.maxTokens || 4096
      });
      return json(res, 200, { text: result, provider: "bedrock" });
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Content System local server → http://localhost:${PORT}`);
  console.log("Endpoints: POST /upload/image | POST /ai/translate | POST /ai/complete | GET /health");
  console.log("Bedrock:", bedrockClient ? BEDROCK_MODEL_ID + " @ " + AWS_REGION : "wyłączony (brak credentials?)");
});
