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
  deleteWsadPost,
  deleteWsadTitle,
  getDeletedIds,
  getPostsForUser,
  getWsadPostsForUser,
  getWsadTitlesForUser,
  initDb,
  replaceWsadPostsForUser,
  replaceWsadTitlesForUser,
  setDeletedIds,
  upsertPost,
  upsertWsadPost,
  upsertWsadTitle
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
/** Titan Image jest tylko w US (nie w eu-central-1) — domyślnie us-east-1 */
const BEDROCK_IMAGE_MODEL_ID =
  process.env.BEDROCK_IMAGE_MODEL_ID || "amazon.titan-image-generator-v2:0";
const BEDROCK_IMAGE_REGION = process.env.BEDROCK_IMAGE_REGION || "us-east-1";

let bedrockImageClients = new Map();
let bedrockImageInitFailed = false;

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

async function getBedrockImageClient(region) {
  const r = region || BEDROCK_IMAGE_REGION;
  if (bedrockImageClients.has(r)) return bedrockImageClients.get(r);
  if (bedrockImageInitFailed) return null;
  try {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({ region: r });
    bedrockImageClients.set(r, client);
    return client;
  } catch (err) {
    bedrockImageInitFailed = true;
    console.warn("Bedrock image client init skipped:", err.message);
    return null;
  }
}

function buildThumbnailPrompt({ title, seed, keywords }) {
  const kws = (keywords || []).filter(Boolean).slice(0, 5).join(", ");
  const topic = String(seed || title || "health wellness").trim();
  return (
    "Editorial blog hero thumbnail, clean modern lifestyle photography style, " +
    "soft natural lighting, shallow depth of field, no text, no watermark, no logos, " +
    "no UI screenshots. Theme: " + topic +
    (title ? ". Article angle: " + String(title).slice(0, 120) : "") +
    (kws ? ". Related concepts: " + kws : "") +
    ". Tasteful, trustworthy, magazine cover mood. 16:9 composition."
  ).slice(0, 512);
}

function buildThumbnailAlt({ title, seed, keywords }) {
  const primary = String(title || seed || "Blog topic").trim();
  const extra = (keywords || []).filter(Boolean).slice(0, 2).join(", ");
  const alt = extra
    ? primary + " — " + extra + " blog thumbnail"
    : primary + " — blog thumbnail illustration";
  return alt.slice(0, 160);
}

function getImageModelCandidates() {
  const preferred = {
    modelId: BEDROCK_IMAGE_MODEL_ID,
    region: BEDROCK_IMAGE_REGION,
    family: BEDROCK_IMAGE_MODEL_ID.includes("nova-canvas")
      ? "Amazon Nova Canvas"
      : "Amazon Titan Image Generator v2"
  };
  const fallbacks = [
    preferred,
    { modelId: "amazon.titan-image-generator-v2:0", region: "us-east-1", family: "Amazon Titan Image Generator v2" },
    { modelId: "amazon.titan-image-generator-v2:0", region: "us-west-2", family: "Amazon Titan Image Generator v2" },
    { modelId: "amazon.nova-canvas-v1:0", region: "us-east-1", family: "Amazon Nova Canvas" },
    { modelId: "amazon.nova-canvas-v1:0", region: "eu-west-1", family: "Amazon Nova Canvas" }
  ];
  const seen = new Set();
  return fallbacks.filter(function (c) {
    const key = c.region + "::" + c.modelId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function invokeImageModel({ client, modelId, textPrompt, width, height }) {
  const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const isNova = String(modelId).includes("nova-canvas");
  const bodyObj = {
    taskType: "TEXT_IMAGE",
    textToImageParams: {
      text: textPrompt
    },
    imageGenerationConfig: {
      numberOfImages: 1,
      quality: "standard",
      height: height,
      width: width
    }
  };
  if (!isNova) {
    bodyObj.textToImageParams.negativeText =
      "text, watermark, logo, blurry, low quality, deformed hands, collage, screenshot";
    bodyObj.imageGenerationConfig.cfgScale = 8;
  }
  const response = await client.send(new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(bodyObj)
  }));
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  if (parsed.error) throw new Error(String(parsed.error));
  const b64 = parsed.images && parsed.images[0];
  if (!b64) throw new Error("Brak obrazu w odpowiedzi modelu");
  return b64;
}

async function generateWsadThumbnail({ title, seed, keywords, prompt }) {
  const textPrompt = String(prompt || buildThumbnailPrompt({ title, seed, keywords })).slice(0, 512);
  const candidates = getImageModelCandidates();
  const errors = [];
  let b64 = null;
  let used = null;

  for (const candidate of candidates) {
    const client = await getBedrockImageClient(candidate.region);
    if (!client) {
      errors.push(candidate.region + "/" + candidate.modelId + ": brak klienta Bedrock");
      continue;
    }
    try {
      try {
        b64 = await invokeImageModel({
          client: client,
          modelId: candidate.modelId,
          textPrompt: textPrompt,
          width: 1280,
          height: 768
        });
      } catch (sizeErr) {
        b64 = await invokeImageModel({
          client: client,
          modelId: candidate.modelId,
          textPrompt: textPrompt,
          width: 1024,
          height: 1024
        });
      }
      used = candidate;
      break;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn("WSAD thumbnail candidate failed:", candidate.region, candidate.modelId, msg);
      errors.push(candidate.region + "/" + candidate.modelId + ": " + msg);
    }
  }

  if (!b64 || !used) {
    throw new Error(
      "Nie udało się wygenerować thumbnaila. Włącz Titan Image (us-east-1) lub Nova Canvas w Bedrock. " +
      "Ostatnie błędy: " + errors.slice(0, 3).join(" | ")
    );
  }

  const slug = slugifyPl(title || seed || "thumbnail") || "thumbnail";
  const saved = saveUploadedImage({
    filename: "thumb-" + slug + ".png",
    data: b64
  });
  const alt = buildThumbnailAlt({ title, seed, keywords });
  const cost = {
    modelId: used.modelId,
    family: used.family,
    totalUsd: 0.008,
    totalUsdDisplay: "0.008",
    currency: "USD",
    note: "Estimate for Bedrock image generation (" + used.region + " / " + used.modelId + ")."
  };

  return {
    path: saved.path,
    filename: saved.filename,
    url: saved.path,
    alt: alt,
    prompt: textPrompt,
    cost: cost,
    modelId: used.modelId,
    region: used.region
  };
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

function parseBedrockBody(modelId, rawBody) {
  const parsed = JSON.parse(new TextDecoder().decode(rawBody));
  let text = "";
  if (isAnthropicModel(modelId)) {
    text = (parsed.content && parsed.content[0] && parsed.content[0].text) || "";
  } else if (modelId.startsWith("amazon.nova")) {
    const msg = parsed.output && parsed.output.message;
    if (msg && msg.content && msg.content[0]) text = msg.content[0].text || "";
  } else if (parsed.results && parsed.results[0] && parsed.results[0].outputText) {
    text = parsed.results[0].outputText;
  } else if (parsed.generation) {
    text = parsed.generation;
  } else {
    text = parsed.outputText || parsed.completion || "";
  }

  const usageRaw = parsed.usage || {};
  const inputTokens = Number(
    usageRaw.input_tokens || usageRaw.inputTokens || usageRaw.prompt_tokens || 0
  ) || 0;
  const outputTokens = Number(
    usageRaw.output_tokens || usageRaw.outputTokens || usageRaw.completion_tokens || 0
  ) || 0;

  return {
    text: String(text || "").trim(),
    usage: {
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      totalTokens: inputTokens + outputTokens
    },
    raw: parsed
  };
}

/** Stawki USD / 1M tokenów — Claude Opus 4.x na Bedrock (global). Regional (eu./us.) ≈ +10%. */
function getBedrockPricing(modelId) {
  const id = String(modelId || BEDROCK_MODEL_ID || "").toLowerCase();
  let inputPerM = 5;
  let outputPerM = 25;
  let family = "Claude Opus (default Bedrock rates)";

  if (id.includes("haiku")) {
    inputPerM = 1;
    outputPerM = 5;
    family = "Claude Haiku";
  } else if (id.includes("sonnet")) {
    inputPerM = 3;
    outputPerM = 15;
    family = "Claude Sonnet";
  } else if (id.includes("opus")) {
    inputPerM = 5;
    outputPerM = 25;
    family = id.includes("opus-4-8") || id.includes("opus-4.8")
      ? "Claude Opus 4.8"
      : id.includes("opus-4-5") || id.includes("opus-4.5")
        ? "Claude Opus 4.5"
        : "Claude Opus";
  }

  const regional = /^(eu|us|ap|me|ca|sa|af)\./.test(id) || id.includes(".eu.") || id.startsWith("eu.");
  const regionalMultiplier = regional ? 1.1 : 1;
  return {
    family: family,
    modelId: modelId || BEDROCK_MODEL_ID,
    inputPerMUsd: inputPerM * regionalMultiplier,
    outputPerMUsd: outputPerM * regionalMultiplier,
    regional: regional,
    note: regional
      ? "Regional Bedrock endpoint (~+10% vs global). Rates are estimates — check AWS Bedrock pricing."
      : "Global Bedrock rates (estimate). Verify on AWS Bedrock pricing page."
  };
}

function estimateBedrockCost(usage, modelId) {
  const pricing = getBedrockPricing(modelId);
  const inputTokens = Number((usage && usage.inputTokens) || 0);
  const outputTokens = Number((usage && usage.outputTokens) || 0);
  const inputUsd = (inputTokens / 1e6) * pricing.inputPerMUsd;
  const outputUsd = (outputTokens / 1e6) * pricing.outputPerMUsd;
  const totalUsd = inputUsd + outputUsd;
  return {
    modelId: pricing.modelId,
    family: pricing.family,
    regional: pricing.regional,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputUsd: Number(inputUsd.toFixed(6)),
    outputUsd: Number(outputUsd.toFixed(6)),
    totalUsd: Number(totalUsd.toFixed(6)),
    totalUsdDisplay: totalUsd < 0.01 ? totalUsd.toFixed(4) : totalUsd.toFixed(3),
    rates: {
      inputPerMUsd: pricing.inputPerMUsd,
      outputPerMUsd: pricing.outputPerMUsd
    },
    note: pricing.note,
    currency: "USD"
  };
}

function estimateTokensFromText(text) {
  // Rough fallback when Bedrock usage missing: ~4 chars / token for English
  const s = String(text || "");
  return Math.max(1, Math.ceil(s.length / 4));
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
  const parsed = parseBedrockBody(modelId, response.body);
  let usage = parsed.usage;
  if (!usage.inputTokens && !usage.outputTokens) {
    const inEst = estimateTokensFromText((system || "") + "\n" + (prompt || ""));
    const outEst = estimateTokensFromText(parsed.text);
    usage = {
      inputTokens: inEst,
      outputTokens: outEst,
      totalTokens: inEst + outEst,
      estimated: true
    };
  }
  return {
    text: parsed.text,
    usage: usage,
    cost: estimateBedrockCost(usage, modelId),
    modelId: modelId
  };
}

async function translateText({ text, sourceLang, targetLang }) {
  const src = sourceLang || "en";
  const tgt = targetLang || "pl";
  const system =
    "You are a professional translator for IT and cloud industry content. " +
    "Return ONLY the translated text, without quotes or commentary.";
  const prompt = "Translate from " + src + " to " + tgt + ":\n\n" + text;
  const result = await invokeBedrock({ system, prompt, maxTokens: 4096 });
  return result.text;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Pusta odpowiedź modelu");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Nie udało się sparsować JSON z odpowiedzi AI");
  }
}

function estimateKd(term) {
  const t = String(term || "").trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const commercial = /(najlepszy|cena|kup|sklep|ranking|porownanie|vs|opinie)/i.test(t);
  if (words.length >= 4 || /(jak |co to |dlaczego |czy |poradnik|krok po kroku)/i.test(t)) {
    return commercial ? "medium" : "low";
  }
  if (words.length === 1) return commercial ? "high" : "high";
  if (words.length === 2) return commercial ? "high" : "medium";
  return "medium";
}

function slugifyPl(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function countVisibleChars(text) {
  return String(text || "").replace(/\s+/g, " ").trim().length;
}

function fallbackWsadAnalysis(seed, language) {
  const s = String(seed || "").trim();
  const lang = (language || "en").toLowerCase();
  if (lang !== "pl") {
    return {
      seed: s,
      intent: "Informational with light commercial intent — readers want to understand \"" + s + "\" and get actionable takeaways.",
      primaryKeyword: s,
      keywords: [
        { term: s, kd: estimateKd(s), reason: "Primary head term — usually higher competition" },
        { term: "what is " + s, kd: "low", reason: "Definitional long-tail, easier entry" },
        { term: "how " + s + " works", kd: "low", reason: "Informational how-to intent" },
        { term: s + " guide", kd: "medium", reason: "Guide intent, moderate competition" },
        { term: s + " best practices", kd: "medium", reason: "Expertise-focused mid KD" },
        { term: "common " + s + " mistakes", kd: "low", reason: "Problem-aware long-tail" },
        { term: s + " vs alternatives", kd: "high", reason: "Comparison / commercial — high KD" },
        { term: s + " checklist 2026", kd: "medium", reason: "Freshness + checklist format" },
        { term: "benefits of " + s, kd: "medium", reason: "Benefit-driven mid funnel" },
        { term: "is " + s + " worth it", kd: "medium", reason: "Decision-stage query" }
      ],
      titles: [
        { title: s + ": The Complete 2026 Guide (Practical & No-Fluff)", rationale: "Year + practical promise, strong CTR" },
        { title: "What Is " + s + "? Clear Definition, Examples & Key Takeaways", rationale: "Definition + snippet-friendly" },
        { title: "How " + s + " Works in Practice (Step-by-Step)", rationale: "How-to intent, featured snippet" },
        { title: s + " Best Practices for 2026: What Actually Matters", rationale: "Freshness + authority" },
        { title: "Common " + s + " Mistakes (And How to Avoid Them)", rationale: "Problem-solution engagement" },
        { title: s + " Checklist: Key Takeaways You Can Use Today", rationale: "Checklist / AI Overviews friendly" },
        { title: "Is " + s + " Worth It? Pros, Cons & Realistic Expectations", rationale: "Decision intent" },
        { title: s + " vs Alternatives: How to Choose the Right Approach", rationale: "Comparison angle" },
        { title: "A Beginner's Guide to " + s + " (Start Here)", rationale: "Beginner low-KD angle" },
        { title: s + " Explained: Benefits, Risks & Practical Tips", rationale: "Balanced explainer" },
        { title: "How to Get Started with " + s + " in 2026", rationale: "Onboarding long-tail" },
        { title: "The Smart Way to Use " + s + " Without Wasting Time", rationale: "Efficiency / unique angle" }
      ],
      metaDescription:
        "Learn what " + s + " is, how it works, and which practices matter in 2026. A concise SEO-ready guide with key takeaways.",
      metaDescriptions: [
        "Learn what " + s + " is, how it works, and which practices matter in 2026. A concise SEO-ready guide with key takeaways.",
        s + " explained: definition, examples, mistakes to avoid, and a practical checklist for better results."
      ],
      outline: [
        "Introduction: why " + s + " matters now",
        "What " + s + " is (plain-English definition)",
        "How " + s + " works in practice",
        "Best practices and common mistakes",
        "Key takeaways / checklist"
      ],
      seoNotes:
        "KD mix: head terms (high) + guides (medium) + long-tail questions (low). Structure for AI Overviews: definition early, bullets, clear H2s. Keep keyword usage natural with entities/synonyms."
    };
  }

  return {
    seed: s,
    intent: "Informacyjna z elementami komercyjnymi — użytkownik chce zrozumieć temat \"" + s + "\" i dostać praktyczne wnioski.",
    primaryKeyword: s,
    keywords: [
      { term: s, kd: estimateKd(s), reason: "Hasło główne — zwykle wyższa konkurencja" },
      { term: s + " — co to jest", kd: "low", reason: "Long-tail definicja, łatwiejsze wejście" },
      { term: "jak " + s + " działa", kd: "low", reason: "Intencja informacyjna, niski KD" },
      { term: s + " w praktyce", kd: "medium", reason: "Środek lejka, umiarkowana konkurencja" },
      { term: "najczęstsze błędy " + s, kd: "low", reason: "Problem-aware long-tail" },
      { term: s + " ranking", kd: "high", reason: "Komercyjne / porównawcze — wysoki KD" },
      { term: s + " poradnik 2026", kd: "medium", reason: "Freshness + poradnik, medium KD" },
      { term: "czy warto " + s, kd: "medium", reason: "Decyzyjne zapytanie" }
    ],
    titles: [
      { title: s + ": kompletny poradnik na 2026 (praktycznie i bez ściemy)", rationale: "Rok + obietnica praktyki, dobry CTR" },
      { title: "Jak działa " + s + "? Wyjaśnienie, przykłady i kluczowe wnioski", rationale: "Pytanie w tytule + featured snippet" },
      { title: s + " — co warto wiedzieć, zanim zaczniesz", rationale: "Beginner intent, niższy KD" },
      { title: "Najczęstsze błędy przy: " + s + " (i jak ich uniknąć)", rationale: "Problem-solution, wysoki engagement" },
      { title: s + " w praktyce: checklista i kluczowe takeaways", rationale: "Checklist + AI Overviews friendly" },
      { title: "Czy warto " + s + "? Plusy, minusy i realistyczne oczekiwania", rationale: "Decision intent" },
      { title: s + " vs alternatywy: jak wybrać właściwe podejście", rationale: "Comparison angle" },
      { title: "Poradnik dla początkujących: " + s, rationale: "Beginner low-KD" },
      { title: s + " wyjaśnione: korzyści, ryzyka i praktyczne tipy", rationale: "Balanced explainer" },
      { title: "Jak zacząć z " + s + " w 2026", rationale: "Onboarding long-tail" }
    ],
    metaDescription:
      "Sprawdź, czym jest " + s + ", jak działa w praktyce i jakie błędy omijać. Krótki przewodnik SEO 2026 z key takeaways.",
    metaDescriptions: [
      "Sprawdź, czym jest " + s + ", jak działa w praktyce i jakie błędy omijać. Krótki przewodnik SEO 2026 z key takeaways.",
      s + " — definicja, przykłady i konkretne wnioski. Przewodnik zoptymalizowany pod intencję wyszukiwania."
    ],
    outline: [
      "Wprowadzenie: dlaczego " + s + " ma znaczenie",
      "Co to jest " + s + " (prosto i konkretnie)",
      "Jak " + s + " działa w praktyce",
      "Najczęstsze błędy i jak ich uniknąć",
      "Key takeaways / checklista"
    ],
    seoNotes:
      "Mix KD: head + long-tail. Struktura pod AI Overviews: definicja, lista wniosków, jasne H2."
  };
}

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeKeywordKey(term) {
  return String(term || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fallbackWsadExtraKeywords(seed, excludeKeywords, language) {
  const s = String(seed || "").trim();
  const lang = (language || "en").toLowerCase();
  const pool = lang === "pl"
    ? [
        { term: s + " dla początkujących", kd: "low", reason: "Beginner long-tail" },
        { term: s + " trendy 2026", kd: "medium", reason: "Freshness mid KD" },
        { term: "koszt " + s, kd: "medium", reason: "Commercial mid-funnel" },
        { term: s + " przykłady", kd: "low", reason: "Example intent" },
        { term: "zalety i wady " + s, kd: "medium", reason: "Pros/cons intent" },
        { term: s + " case study", kd: "low", reason: "Proof / experience" },
        { term: "narzędzia do " + s, kd: "medium", reason: "Tools angle" },
        { term: s + " checklista", kd: "low", reason: "Actionable format" }
      ]
    : [
        { term: s + " for beginners", kd: "low", reason: "Beginner long-tail" },
        { term: s + " trends 2026", kd: "medium", reason: "Freshness mid KD" },
        { term: s + " cost", kd: "medium", reason: "Commercial mid-funnel" },
        { term: s + " examples", kd: "low", reason: "Example intent" },
        { term: s + " pros and cons", kd: "medium", reason: "Pros/cons intent" },
        { term: s + " case study", kd: "low", reason: "Proof / experience" },
        { term: "tools for " + s, kd: "medium", reason: "Tools angle" },
        { term: s + " checklist", kd: "low", reason: "Actionable format" },
        { term: "advanced " + s + " tips", kd: "medium", reason: "Advanced mid KD" },
        { term: s + " strategy", kd: "high", reason: "Strategy head-ish term" }
      ];
  const excluded = new Set((excludeKeywords || []).map(normalizeKeywordKey));
  const out = [];
  for (let i = 0; i < pool.length && out.length < 3; i++) {
    if (!excluded.has(normalizeKeywordKey(pool[i].term))) out.push(pool[i]);
  }
  if (!out.length) {
    out.push({
      term: s + " angle " + Date.now().toString().slice(-4),
      kd: "low",
      reason: "Fresh unique keyword fallback"
    });
  }
  return out;
}

function fallbackWsadExtraTitle(seed, excludeTitles, language, excludeKeywords) {
  const s = String(seed || "").trim();
  const lang = (language || "en").toLowerCase();
  const pool = lang === "pl"
    ? [
        s + ": fakty, mity i praktyczne wnioski",
        "Dlaczego " + s + " zyskuje na znaczeniu w 2026",
        s + " — szybki start bez zbędnej teorii",
        "Od zera do efektu: " + s + " w 7 krokach",
        "Co eksperci mówią o " + s + " (i czego unikają)",
        s + " w realnych scenariuszach: case-style guide",
        "Mały przewodnik po " + s + " dla zajętych ludzi",
        s + ": pytania, które warto zadać przed startem",
        s + " — trendy, koszty i realne przykłady",
        "Jak wybrać podejście do " + s + " bez chaosu"
      ]
    : [
        s + ": Facts, Myths & Practical Takeaways",
        "Why " + s + " Matters More in 2026",
        s + " — A Fast Start Without the Noise",
        "From Zero to Results: " + s + " in 7 Steps",
        "What Experts Get Right About " + s + " (And What They Avoid)",
        s + " in Real Scenarios: A Case-Style Guide",
        "A Short " + s + " Playbook for Busy People",
        s + ": Questions Worth Asking Before You Start",
        "Unlock Better Results with " + s + " (Without Overcomplicating It)",
        "The No-Nonsense " + s + " Framework for 2026",
        s + " Trends, Costs & Real-World Examples",
        "How to Choose a " + s + " Approach Without Chaos",
        s + " Strategy That Actually Scales",
        "Advanced " + s + " Tips Most Guides Skip"
      ];
  const excluded = new Set((excludeTitles || []).map(normalizeTitleKey));
  let titleObj = null;
  for (let i = 0; i < pool.length; i++) {
    if (!excluded.has(normalizeTitleKey(pool[i]))) {
      titleObj = {
        title: pool[i],
        rationale: lang === "pl" ? "Unikalny wariant CTR / intencji" : "Unique CTR / intent angle"
      };
      break;
    }
  }
  if (!titleObj) {
    const stamp = Date.now().toString().slice(-4);
    titleObj = {
      title: (lang === "pl" ? (s + " — świeży kąt #" + stamp) : (s + " — Fresh Angle #" + stamp)),
      rationale: "Guaranteed unique fallback title"
    };
  }
  titleObj.keywords = fallbackWsadExtraKeywords(seed, excludeKeywords, language);
  return titleObj;
}

function fallbackWsadPost({ seed, title, metaDescription, analysis, language }) {
  const lang = (language || "en").toLowerCase();
  const s = seed || (analysis && analysis.primaryKeyword) || "topic";
  const t = title || (lang === "pl" ? (s + " — poradnik") : (s + " — practical guide"));
  const kws = ((analysis && analysis.keywords) || [])
    .map(function (k) { return k.term; })
    .filter(Boolean)
    .slice(0, 6);

  if (lang !== "pl") {
    const body =
      "You're dealing with **" + s + "** and the usual advice feels scattered. This guide cuts through the noise with a practical structure you can use today.\n\n" +
      "Below you'll get a clear definition, the decision framework that matters in 2026, step-by-step actions, and answers to the questions people actually search for — including how **Cardiom** can support related self-checks.\n\n" +
      "## Key Takeaways\n\n" +
      "- Clarify what \"" + s + "\" really means for your day-to-day decisions.\n" +
      "- Use a low/medium/high KD keyword mix (" + (kws.slice(0, 4).join(", ") || s) + ") without stuffing.\n" +
      "- Follow a short checklist instead of vague tips.\n" +
      "- Prefer structured takeaways and FAQ sections for AI Overviews.\n" +
      "- Try **Cardiom** when heart-rate or recovery context is relevant.\n\n" +
      "## Table of Contents\n\n" +
      "- What " + s + " is and why it matters\n" +
      "- How " + s + " works in practice\n" +
      "- 5 steps to get started\n" +
      "- Common mistakes to avoid\n" +
      "- Measuring pulse with Cardiom\n" +
      "- Frequently Asked Questions\n\n" +
      "## What " + s + " is and why it matters\n\n" +
      s.charAt(0).toUpperCase() + s.slice(1) +
      " is easiest to understand when you start from the reader's problem, then define the concept in plain language. Strong SEO writing combines natural language with related entities instead of exact-match stuffing.\n\n" +
      "### The problem most guides skip\n\n" +
      "People searching for \"" + s + "\" usually want a definition plus actionable next steps — not a glossary dump. Lead with intent, then expand with examples.\n\n" +
      "## How " + s + " works in practice\n\n" +
      "Start from the reader's constraint, explain the mechanism, then give a concrete example. Weave related phrases (" +
      (kws.join(", ") || s) +
      ") while staying readable.\n\n" +
      "## 5 steps to get started\n\n" +
      "1. Define the outcome you want from \"" + s + "\".\n" +
      "2. Map the related questions people ask next.\n" +
      "3. Build a short checklist you can reuse weekly.\n" +
      "4. Track one measurable signal (time saved, consistency, recovery, etc.).\n" +
      "5. Iterate — keep only what you actually use.\n\n" +
      "## Common mistakes to avoid\n\n" +
      "1. Targeting only high-KD terms with no long-tail support.\n" +
      "2. Skipping key takeaways and FAQ.\n" +
      "3. Vague advice with no concrete steps.\n" +
      "4. Keyword stuffing that hurts clarity.\n\n" +
      "## Measuring pulse with Cardiom\n\n" +
      "**Cardiom** lets you check heart rate using your phone camera, and also offers an innovative face-based system that estimates pulse from vital-sign signals — useful for quick self-checks without a wearable.\n\n" +
      "## Reclaim clarity on " + s + "\n\n" +
      "A well-structured guide about **" + s + "** balances readability, keyword mix, and depth. Use the checklist above, keep your notes searchable, and bring Cardiom in when vitals context helps.\n\n" +
      "## Frequently Asked Questions\n\n" +
      "### What is the fastest way to start with " + s + "?\n\n" +
      "Start with one clear outcome, then follow a five-step checklist instead of collecting endless tips.\n\n" +
      "### Do I need expensive tools?\n\n" +
      "Not at first. Focus on process; add tools like **Cardiom** only when they remove friction.\n\n" +
      "### How is this different from generic advice?\n\n" +
      "This structure prioritizes intent match, scannable takeaways, and practical steps over filler.";

    return {
      title: t,
      slug: slugifyPl(t),
      metaDescription: metaDescription || "",
      contentMd: body,
      charCount: countVisibleChars(body),
      wordCount: body.trim().split(/\s+/).length,
      keywordsUsed: kws
    };
  }

  const body =
    "# " + t + "\n\n" +
    (metaDescription || "") + "\n\n" +
    "W tym artykule zbieramy praktyczną wiedzę o **" + s + "**: czym jest, jak podejść do tematu w 2026 i które wnioski realnie pomagają w decyzjach.\n\n" +
    "## Spis treści\n\n" +
    "1. Czym jest " + s + "\n" +
    "2. Jak " + s + " działa w praktyce\n" +
    "3. Najczęstsze błędy\n" +
    "4. Key takeaways\n\n" +
    "## Key takeaways\n\n" +
    "- Zrozum intencję: użytkownicy szukają \"" + s + "\" zwykle po definicję i praktyczne wskazówki.\n" +
    "- Buduj autorytet tematyczny: odpowiadaj na pytania pokrewne (" + (kws.slice(1, 4).join(", ") || "long-tail") + ").\n" +
    "- Mieszaj frazy low/medium/high KD zamiast celować tylko w najtrudniejsze hasło.\n" +
    "- Pisz konkretnie: przykłady, checklisty i wnioski zwiększają szansę na wyróżnienie w wynikach.\n\n" +
    "## Czym jest " + s + "\n\n" +
    s.charAt(0).toUpperCase() + s.slice(1) +
    " to temat, wokół którego warto zebrać definicję, kontekst i zastosowania. Dobry wpis łączy język naturalny z frazami kluczowymi, zamiast sztucznego upychania słów.\n\n" +
    "## Jak " + s + " działa w praktyce\n\n" +
    "Zacznij od problemu czytelnika, potem przejdź do mechanizmu i przykładów. Wpleć synonimy i frazy pokrewne (" +
    (kws.join(", ") || s) +
    "), ale utrzymuj czytelność.\n\n" +
    "## Najczęstsze błędy\n\n" +
    "1. Celowanie wyłącznie w high KD bez long-tail.\n" +
    "2. Brak spisu treści i key takeaways.\n" +
    "3. Ogólniki zamiast konkretów.\n" +
    "4. Keyword stuffing kosztem sensu.\n\n" +
    "Podsumowując: dobrze zoptymalizowany tekst o **" + s + "** łączy czytelność, mix KD i strukturę.";

  return {
    title: t,
    slug: slugifyPl(t),
    metaDescription: metaDescription || "",
    contentMd: body,
    charCount: countVisibleChars(body),
    wordCount: body.trim().split(/\s+/).length,
    keywordsUsed: kws
  };
}

async function wsadAnalyzeWithAi(seed, language, excludeTitles) {
  const lang = (language || "en").toLowerCase();
  const excluded = (excludeTitles || []).filter(Boolean);
  const system =
    "You are an SEO strategist for 2026 (Google + AI Overviews). " +
    "Estimate keyword difficulty (KD) as low / medium / high. " +
    "Always return a MIX of low (long-tail), medium, and high KD terms. " +
    "Use search intent, E-E-A-T, entity SEO, featured snippets, People Also Ask, and natural language. " +
    "Write ALL user-facing strings in " + (lang === "pl" ? "Polish" : "English") + ". " +
    "Return ONLY valid JSON with no commentary.";
  const prompt =
    "Language: " + lang + "\n" +
    "Seed keyword: \"" + seed + "\"\n\n" +
    (excluded.length
      ? ("Do NOT reuse these existing titles (exact or close paraphrase):\n- " + excluded.join("\n- ") + "\n\n")
      : "") +
    "Create a blog SEO analysis. JSON schema:\n" +
    "{\n" +
    "  \"seed\": string,\n" +
    "  \"intent\": string,\n" +
    "  \"primaryKeyword\": string,\n" +
    "  \"keywords\": [{\"term\": string, \"kd\": \"low\"|\"medium\"|\"high\", \"reason\": string}],\n" +
    "  \"titles\": [{\"title\": string, \"rationale\": string}],\n" +
    "  \"metaDescription\": string,\n" +
    "  \"metaDescriptions\": [string],\n" +
    "  \"outline\": [string],\n" +
    "  \"seoNotes\": string\n" +
    "}\n" +
    "Requirements: 8-12 keywords (KD mix), AT LEAST 10 unique SEO-optimized titles for CTR in 2026, outline 5-7 H2s, meta ~150-160 chars. Every title must be distinct from each other and from excluded titles. Prefer fresh keyword angles.";
  const result = await invokeBedrock({ system, prompt, maxTokens: 4500 });
  const parsed = extractJsonObject(result.text);
  if (!parsed.keywords || !parsed.keywords.length) {
    parsed.keywords = fallbackWsadAnalysis(seed, lang).keywords;
  }
  parsed.keywords = parsed.keywords.map(function (kw) {
    return {
      term: kw.term || kw.keyword || seed,
      kd: String(kw.kd || estimateKd(kw.term || seed)).toLowerCase(),
      reason: kw.reason || kw.intent || ""
    };
  });
  const excludedSet = new Set(excluded.map(normalizeTitleKey));
  parsed.titles = (parsed.titles || []).filter(function (t) {
    return !excludedSet.has(normalizeTitleKey(typeof t === "string" ? t : t.title));
  });
  if (!parsed.titles || parsed.titles.length < 10) {
    const fb = fallbackWsadAnalysis(seed, lang).titles;
    const existing = new Set((parsed.titles || []).map(function (t) {
      return normalizeTitleKey(typeof t === "string" ? t : t.title);
    }));
    excluded.forEach(function (t) { existing.add(normalizeTitleKey(t)); });
    parsed.titles = parsed.titles || [];
    fb.forEach(function (t) {
      const key = normalizeTitleKey(t.title);
      if (!existing.has(key)) {
        parsed.titles.push(t);
        existing.add(key);
      }
    });
  }
  return parsed;
}

async function wsadMoreTitleWithAi(seed, excludeTitles, language, analysis, excludeKeywords) {
  const lang = (language || "en").toLowerCase();
  const excluded = (excludeTitles || []).filter(Boolean);
  const excludedKw = (excludeKeywords || []).filter(Boolean);
  const system =
    "You invent one unique SEO blog title for 2026 AND 2-3 fresh related keywords. " +
    "The title must NOT repeat or closely paraphrase any excluded title. " +
    "Keywords must be NEW (not in the excluded keyword list) and mix KD (low/medium/high). " +
    "Write in " + (lang === "pl" ? "Polish" : "English") + ". Return ONLY JSON.";
  const prompt =
    "Seed: \"" + seed + "\"\n" +
    "Intent: " + ((analysis && analysis.intent) || "") + "\n" +
    "Excluded titles (do not repeat):\n- " + excluded.join("\n- ") + "\n\n" +
    "Already used keywords (do not repeat):\n- " + excludedKw.join("\n- ") + "\n\n" +
    "Return JSON:\n" +
    "{\n" +
    "  \"title\": string,\n" +
    "  \"rationale\": string,\n" +
    "  \"metaDescription\": string,\n" +
    "  \"keywords\": [{\"term\": string, \"kd\": \"low\"|\"medium\"|\"high\", \"reason\": string}]\n" +
    "}\n" +
    "Title must be unique, CTR-oriented, SEO-optimized, and ideally lean on a NEW keyword angle.";
  const result = await invokeBedrock({ system, prompt, maxTokens: 1200 });
  const parsed = extractJsonObject(result.text);
  const title = String(parsed.title || "").trim();
  if (!title) throw new Error("Empty title from model");
  if (excluded.some(function (t) { return normalizeTitleKey(t) === normalizeTitleKey(title); })) {
    throw new Error("Model repeated an existing title");
  }
  const usedKw = new Set(excludedKw.map(normalizeKeywordKey));
  let keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  keywords = keywords.map(function (kw) {
    return {
      term: kw.term || kw.keyword || "",
      kd: String(kw.kd || estimateKd(kw.term || seed)).toLowerCase(),
      reason: kw.reason || "Fresh keyword angle"
    };
  }).filter(function (kw) {
    return kw.term && !usedKw.has(normalizeKeywordKey(kw.term));
  });
  if (!keywords.length) {
    keywords = fallbackWsadExtraKeywords(seed, excludedKw, language);
  }
  return {
    title: title,
    rationale: parsed.rationale || "",
    metaDescription: parsed.metaDescription || "",
    keywords: keywords.slice(0, 3)
  };
}

const WSAD_CARDIOM_BRIEF =
  "Product to feature in every article: **Cardiom** — an app where users can measure pulse " +
  "with a phone camera, plus an innovative face-based vital-signs system that estimates heart rate " +
  "accurately from facial signals / vital functions (contactless PPG-style measurement). " +
  "Mention Cardiom naturally as a practical tool when the topic relates to health, heart rate, " +
  "wellness, fitness, stress, recovery, or self-monitoring. Even for broader topics, include a short, " +
  "relevant Cardiom mention or soft CTA (not spammy). Prefer a dedicated short H2/H3 when it fits, " +
  "plus one mention in key takeaways or closing CTA.";

/**
 * Style reference: professional consumer SEO blogs like
 * https://yumishare.com/blog/how-to-create-a-digital-family-cookbook-2026-guide/
 * Structure, depth, and tone — NOT the product/topic itself.
 */
const WSAD_BLOG_STYLE_GUIDE =
  "STYLE TEMPLATE (match this depth & polish; do NOT copy its product or wording):\n" +
  "Reference pattern: YumiShare-style longform SEO guide.\n\n" +
  "1) OPENING HOOK (2 short paragraphs):\n" +
  "   - Start with a vivid, relatable scene or pain point the reader recognizes.\n" +
  "   - Second paragraph: empathy + promise of what this guide delivers + soft roadmap.\n" +
  "2) ## Key Takeaways — 5 concrete bullets (actionable, not fluff); weave primary keyword naturally.\n" +
  "3) ## Table of Contents — 5–7 H2 titles as a bullet list matching the real sections below.\n" +
  "4) BODY DEPTH (the important part):\n" +
  "   - Several H2 sections that truly DEVELOP the topic (problem → explanation → practical value).\n" +
  "   - Under major H2s, use H3s for sub-problems, comparisons, steps, or myths.\n" +
  "   - Include at least one numbered/step-by-step H2 (e.g. 5 steps…).\n" +
  "   - Use concrete examples, checklists, and 'why it matters' — avoid shallow one-paragraph H2s.\n" +
  "   - Conversational but professional; address the reader as 'you'; short–medium paragraphs.\n" +
  "5) PRODUCT SECTION: one H2 (or H3) that positions Cardiom as a practical solution — useful, not salesy.\n" +
  "6) CLOSING H2: summarize transformation + soft CTA (Cardiom where natural).\n" +
  "7) ## Frequently Asked Questions — 5–8 Q&As with full 2–4 sentence answers (PAA-style).\n" +
  "Tone: calm authority, specific language, no keyword stuffing, no fake stats, no filler.";

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 9000);
  try {
    const res = await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function researchWikipedia(query) {
  const items = [];
  try {
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=opensearch&limit=3&namespace=0&format=json&search=" +
      encodeURIComponent(query);
    const searchRes = await fetchWithTimeout(searchUrl, {
      headers: { Accept: "application/json", "User-Agent": "ContentSystemWSAD/1.0" }
    }, 8000);
    if (!searchRes.ok) return items;
    const data = JSON.parse(searchRes.text);
    const titles = (data && data[1]) || [];
    for (const title of titles.slice(0, 2)) {
      const sumUrl =
        "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
      const sumRes = await fetchWithTimeout(sumUrl, {
        headers: { Accept: "application/json", "User-Agent": "ContentSystemWSAD/1.0" }
      }, 8000);
      if (!sumRes.ok) continue;
      const sum = JSON.parse(sumRes.text);
      if (sum && sum.extract) {
        items.push({
          source: "Wikipedia",
          title: sum.title || title,
          url: (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) || "",
          snippet: String(sum.extract).slice(0, 700)
        });
      }
    }
  } catch (err) {
    console.warn("WSAD wiki research:", err.message);
  }
  return items;
}

async function researchDuckDuckGo(query) {
  const items = [];
  try {
    const url =
      "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(query);
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "ContentSystemWSAD/1.0" }
    }, 8000);
    if (!res.ok) return items;
    const data = JSON.parse(res.text);
    if (data.AbstractText) {
      items.push({
        source: "DuckDuckGo",
        title: data.Heading || query,
        url: data.AbstractURL || "",
        snippet: String(data.AbstractText).slice(0, 700)
      });
    }
    (data.RelatedTopics || []).slice(0, 5).forEach(function (topic) {
      if (topic && topic.Text) {
        items.push({
          source: "DuckDuckGo",
          title: (topic.FirstURL || "").replace(/^https?:\/\//, "").slice(0, 80),
          url: topic.FirstURL || "",
          snippet: String(topic.Text).slice(0, 400)
        });
      } else if (topic && topic.Topics) {
        topic.Topics.slice(0, 2).forEach(function (t) {
          if (!t || !t.Text) return;
          items.push({
            source: "DuckDuckGo",
            title: (t.FirstURL || "").replace(/^https?:\/\//, "").slice(0, 80),
            url: t.FirstURL || "",
            snippet: String(t.Text).slice(0, 400)
          });
        });
      }
    });
  } catch (err) {
    console.warn("WSAD DDG research:", err.message);
  }
  return items;
}

async function researchGoogleNews(query) {
  const items = [];
  try {
    const url =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(query + " when:365d") +
      "&hl=en-US&gl=US&ceid=US:en";
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent": "Mozilla/5.0 (compatible; ContentSystem/1.0)"
      }
    }, 9000);
    if (!res.ok) return items;
    const xml = res.text;
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    blocks.slice(0, 6).forEach(function (block) {
      const title = stripHtml((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
        block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
      const link = stripHtml((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "");
      const desc = stripHtml((block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
        block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "");
      const pub = stripHtml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "");
      if (!title) return;
      items.push({
        source: "Google News",
        title: title,
        url: link,
        snippet: (pub ? ("[" + pub + "] ") : "") + desc.slice(0, 420)
      });
    });
  } catch (err) {
    console.warn("WSAD news research:", err.message);
  }
  return items;
}

async function researchBrave(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY || "";
  if (!key) return [];
  const items = [];
  try {
    const url = "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=6";
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
        "User-Agent": "ContentSystemWSAD/1.0"
      }
    }, 9000);
    if (!res.ok) return items;
    const data = JSON.parse(res.text);
    ((data.web && data.web.results) || []).slice(0, 6).forEach(function (r) {
      items.push({
        source: "Brave Search",
        title: r.title || "",
        url: r.url || "",
        snippet: String(r.description || "").slice(0, 500)
      });
    });
  } catch (err) {
    console.warn("WSAD Brave research:", err.message);
  }
  return items;
}

async function researchSerper(query) {
  const key = process.env.SERPER_API_KEY || "";
  if (!key) return [];
  const items = [];
  try {
    const res = await fetchWithTimeout("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": key,
        "User-Agent": "ContentSystemWSAD/1.0"
      },
      body: JSON.stringify({ q: query, num: 6 })
    }, 9000);
    if (!res.ok) return items;
    const data = JSON.parse(res.text);
    (data.organic || []).slice(0, 6).forEach(function (r) {
      items.push({
        source: "Serper/Google",
        title: r.title || "",
        url: r.link || "",
        snippet: String(r.snippet || "").slice(0, 500)
      });
    });
  } catch (err) {
    console.warn("WSAD Serper research:", err.message);
  }
  return items;
}

function formatResearchPack(items) {
  if (!items || !items.length) {
    return "RESEARCH PACK: (empty — no live sources returned. Stay general; do NOT invent stats, studies, dates, or product claims.)";
  }
  const lines = [
    "RESEARCH PACK (current web data — treat as the ONLY factual source for specific claims):",
    "Rules: Use these notes for grounding. Do NOT invent percentages, study names, prices, or news.",
    "If a claim is not supported here, write qualitatively or omit numbers.",
    ""
  ];
  items.slice(0, 14).forEach(function (item, idx) {
    lines.push(
      (idx + 1) + ". [" + (item.source || "web") + "] " + (item.title || "") +
      (item.url ? " — " + item.url : "") + "\n   " + (item.snippet || "")
    );
  });
  return lines.join("\n").slice(0, 9000);
}

async function researchTopicForWsad({ seed, title, keywords }) {
  const primary = String(title || seed || "").trim();
  const kw = (keywords || []).filter(Boolean).slice(0, 4).join(" ");
  const query = (primary + " " + kw).trim().slice(0, 160) || String(seed || "health").trim();
  const newsQuery = (seed || primary).trim().slice(0, 100);

  const settled = await Promise.allSettled([
    researchBrave(query),
    researchSerper(query),
    researchWikipedia(seed || primary),
    researchDuckDuckGo(query),
    researchGoogleNews(newsQuery)
  ]);

  const merged = [];
  const seen = new Set();
  settled.forEach(function (result) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) return;
    result.value.forEach(function (item) {
      const key = normalizeTitleKey((item.title || "") + " " + (item.url || ""));
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
  });

  return {
    query: query,
    items: merged,
    packText: formatResearchPack(merged),
    fetchedAt: new Date().toISOString()
  };
}

async function wsadGenerateWithAi(payload) {
  const seed = payload.seed;
  const title = payload.title;
  const meta = payload.metaDescription || "";
  const analysis = payload.analysis || {};
  const targetWords = Math.min(2000, Math.max(1100, Number(payload.targetWords) || Number(payload.targetChars) || 2000));
  const lang = (payload.language || "en").toLowerCase();
  const keywordList = (analysis.keywords || []).map(function (k) { return k.term; }).filter(Boolean);
  const kws = (analysis.keywords || []).map(function (k) { return k.term + " [" + k.kd + "]"; }).join("; ");
  const onProgress = typeof payload.onProgress === "function" ? payload.onProgress : null;

  if (onProgress) onProgress("research");
  let research;
  try {
    research = await researchTopicForWsad({
      seed: seed,
      title: title,
      keywords: keywordList
    });
  } catch (err) {
    console.warn("WSAD research failed:", err.message);
    research = {
      query: title || seed,
      items: [],
      packText: formatResearchPack([]),
      fetchedAt: new Date().toISOString(),
      warning: err.message
    };
  }

  if (onProgress) onProgress("bedrock");
  const system =
    "You are an expert SEO editorial writer for 2026 (Google + AI Overviews). " +
    "Write publish-ready longform guides with the depth and polish of top consumer SaaS blogs " +
    "(structure like a YumiShare-style guide: hook → takeaways → TOC → deep H2/H3 development → steps → FAQ → CTA). " +
    "Write in " + (lang === "pl" ? "Polish" : "English") + ". " +
    "ANTI-HALLUCINATION: Never invent statistics, studies, prices, dates, quotas, rankings, or news. " +
    "Only use specific factual claims that appear in the provided RESEARCH PACK. " +
    "If the pack is thin, stay practical and qualitative — still deliver depth via frameworks, checklists, and examples. " +
    "Feature Cardiom naturally per the product brief. Return ONLY JSON.";

  const prompt =
    "Generate ONE fully optimized blog post in the required editorial style.\n\n" +
    "Language: " + lang + "\n" +
    "Seed: " + seed + "\n" +
    "Title: " + title + "\n" +
    "Meta (target ~150–160 chars): " + meta + "\n" +
    "Keywords (natural mix of low/medium/high KD — do not stuff): " + kws + "\n" +
    "Suggested outline (adapt if research suggests better structure): " + JSON.stringify(analysis.outline || []) + "\n" +
    "HARD LIMIT: maximum " + targetWords + " words in contentMd (aim 1400–1900; never exceed " + targetWords + ").\n" +
    "Prefer dense, useful prose. Count WORDS carefully.\n\n" +
    WSAD_BLOG_STYLE_GUIDE + "\n\n" +
    WSAD_CARDIOM_BRIEF + "\n\n" +
    research.packText + "\n\n" +
    "contentMd Markdown structure (required order):\n" +
    "1) No H1 in body (title is separate) — start with 2 hook paragraphs\n" +
    "2) ## Key Takeaways\n" +
    "3) ## Table of Contents\n" +
    "4) Deep H2/H3 sections developing the topic (problem, pillars, how-to, myths, comparisons as relevant)\n" +
    "5) A practical Cardiom section (H2 or H3) woven into the topic\n" +
    "6) Closing transformation H2 + soft CTA\n" +
    "7) ## Frequently Asked Questions (5–8 items as ### Question then answer paragraphs)\n\n" +
    "Also return keywordsUsed (8–12 phrases) suitable for tagging the post.\n\n" +
    "JSON schema:\n" +
    "{\n" +
    "  \"title\": string,\n" +
    "  \"slug\": string,\n" +
    "  \"metaDescription\": string,\n" +
    "  \"contentMd\": string,\n" +
    "  \"charCount\": number,\n" +
    "  \"wordCount\": number,\n" +
    "  \"keywordsUsed\": [string]\n" +
    "}";

  const result = await invokeBedrock({ system, prompt, maxTokens: 8192 });
  const parsed = extractJsonObject(result.text);
  if (!parsed.contentMd) throw new Error("Missing contentMd in model response");
  parsed.slug = parsed.slug || slugifyPl(parsed.title || title);
  parsed.charCount = parsed.charCount || countVisibleChars(parsed.contentMd);
  parsed.wordCount = parsed.wordCount || parsed.contentMd.trim().split(/\s+/).filter(Boolean).length;
  if (!parsed.keywordsUsed || !parsed.keywordsUsed.length) {
    parsed.keywordsUsed = keywordList.slice(0, 10);
  }
  parsed.keywords = parsed.keywords || parsed.keywordsUsed;
  parsed.usage = result.usage;
  parsed.cost = result.cost;
  parsed.modelId = result.modelId;
  parsed.research = {
    query: research.query,
    fetchedAt: research.fetchedAt,
    sourceCount: (research.items || []).length,
    sources: (research.items || []).slice(0, 8).map(function (item) {
      return {
        source: item.source,
        title: item.title,
        url: item.url
      };
    }),
    warning: research.warning || null
  };
  return parsed;
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.normalize(path.join(__dirname, rel));
  if (!resolved.startsWith(__dirname)) return null;
  return resolved;
}

const wsadJobs = new Map();

function cleanupWsadJobs() {
  const maxAge = 30 * 60 * 1000;
  const now = Date.now();
  for (const [id, job] of wsadJobs.entries()) {
    if (!job || (now - (job.createdAt || 0)) > maxAge) wsadJobs.delete(id);
  }
  while (wsadJobs.size > 40) {
    const first = wsadJobs.keys().next().value;
    wsadJobs.delete(first);
  }
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
      sendJson(req, res, 200, {
        text: result.text,
        provider: "bedrock",
        usage: result.usage,
        cost: result.cost,
        modelId: result.modelId
      });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || "Server error" });
    }
  });

  // Ukryty panel SEO bloga — bez linków w UI; tylko bezpośredni URL /wsad
  app.get(["/wsad", "/wsad/"], function (req, res) {
    const filePath = path.join(__dirname, "wsad", "index.html");
    if (!serveStatic(req, res, filePath)) {
      sendJson(req, res, 404, { error: "WSAD not found" });
    }
  });

  app.post("/api/wsad/analyze", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const seed = String((req.body && req.body.seed) || "").trim();
    if (!seed) return sendJson(req, res, 400, { error: "Podaj hasło (seed)" });
    const language = String((req.body && req.body.language) || "en").toLowerCase();
    const excludeTitles = Array.isArray(req.body && req.body.excludeTitles)
      ? req.body.excludeTitles.map(function (t) { return String(t || "").trim(); }).filter(Boolean)
      : [];
    try {
      const analysis = await wsadAnalyzeWithAi(seed, language, excludeTitles);
      sendJson(req, res, 200, { analysis, provider: "bedrock" });
    } catch (err) {
      console.warn("WSAD analyze fallback:", err.message);
      const analysis = fallbackWsadAnalysis(seed, language);
      if (excludeTitles.length) {
        const excluded = new Set(excludeTitles.map(normalizeTitleKey));
        analysis.titles = (analysis.titles || []).filter(function (t) {
          return !excluded.has(normalizeTitleKey(t.title || t));
        });
      }
      sendJson(req, res, 200, {
        analysis,
        provider: "fallback",
        warning: err.message || "Bedrock niedostępny — użyto analizy lokalnej"
      });
    }
  });

  app.get("/api/wsad/library", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(req, res, 200, {
      titles: getWsadTitlesForUser(auth.user.id),
      posts: getWsadPostsForUser(auth.user.id)
    });
  });

  app.get("/api/wsad/titles", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(req, res, 200, { titles: getWsadTitlesForUser(auth.user.id) });
  });

  app.put("/api/wsad/titles", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const titles = Array.isArray(req.body && req.body.titles) ? req.body.titles : [];
    const saved = replaceWsadTitlesForUser(auth.user.id, titles.slice(0, 200));
    sendJson(req, res, 200, { titles: saved, ok: true });
  });

  app.post("/api/wsad/titles", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const item = upsertWsadTitle(auth.user.id, req.body || {});
      sendJson(req, res, 200, { title: item, ok: true });
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || "Nie udało się zapisać tytułu" });
    }
  });

  app.delete("/api/wsad/titles/:id", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    deleteWsadTitle(auth.user.id, String(req.params.id || ""));
    sendJson(req, res, 200, { ok: true });
  });

  app.get("/api/wsad/posts", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    sendJson(req, res, 200, { posts: getWsadPostsForUser(auth.user.id) });
  });

  app.put("/api/wsad/posts", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const posts = Array.isArray(req.body && req.body.posts) ? req.body.posts : [];
    const saved = replaceWsadPostsForUser(auth.user.id, posts.slice(0, 80));
    sendJson(req, res, 200, { posts: saved, ok: true });
  });

  app.post("/api/wsad/posts", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const item = upsertWsadPost(auth.user.id, req.body || {});
      sendJson(req, res, 200, { post: item, ok: true });
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || "Nie udało się zapisać posta" });
    }
  });

  app.delete("/api/wsad/posts/:id", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    deleteWsadPost(auth.user.id, String(req.params.id || ""));
    sendJson(req, res, 200, { ok: true });
  });

  app.post("/api/wsad/title-more", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const seed = String((req.body && req.body.seed) || "").trim();
    if (!seed) return sendJson(req, res, 400, { error: "Podaj hasło (seed)" });
    const language = String((req.body && req.body.language) || "en").toLowerCase();
    const excludeTitles = Array.isArray(req.body && req.body.excludeTitles)
      ? req.body.excludeTitles.map(function (t) { return String(t || "").trim(); }).filter(Boolean)
      : [];
    const excludeKeywords = Array.isArray(req.body && req.body.excludeKeywords)
      ? req.body.excludeKeywords.map(function (t) { return String(t || "").trim(); }).filter(Boolean)
      : [];
    const analysis = (req.body && req.body.analysis) || null;
    try {
      const titleObj = await wsadMoreTitleWithAi(seed, excludeTitles, language, analysis, excludeKeywords);
      sendJson(req, res, 200, { title: titleObj, provider: "bedrock" });
    } catch (err) {
      console.warn("WSAD title-more fallback:", err.message);
      sendJson(req, res, 200, {
        title: fallbackWsadExtraTitle(seed, excludeTitles, language, excludeKeywords),
        provider: "fallback",
        warning: err.message || "Bedrock niedostępny — użyto lokalnego tytułu"
      });
    }
  });

  app.post("/api/wsad/thumbnail", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const title = String((req.body && req.body.title) || "").trim();
    const seed = String((req.body && req.body.seed) || "").trim();
    if (!title && !seed) {
      return sendJson(req, res, 400, { error: "Podaj title lub seed" });
    }
    const keywords = Array.isArray(req.body && req.body.keywords)
      ? req.body.keywords.map(function (k) {
          return typeof k === "string" ? k : (k && (k.term || k.keyword)) || "";
        }).map(function (s) { return String(s || "").trim(); }).filter(Boolean)
      : String((req.body && req.body.keywordsText) || "")
        .split(/[,;\n]+/)
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
    try {
      const thumb = await generateWsadThumbnail({
        title: title,
        seed: seed,
        keywords: keywords,
        prompt: String((req.body && req.body.prompt) || "").trim() || undefined
      });
      sendJson(req, res, 200, { thumbnail: thumb, provider: "bedrock-titan" });
    } catch (err) {
      console.warn("WSAD thumbnail error:", err.message);
      sendJson(req, res, 500, { error: err.message || "Nie udało się wygenerować thumbnaila" });
    }
  });

  app.post("/api/wsad/generate", async function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const seed = String((req.body && req.body.seed) || "").trim();
    const title = String((req.body && req.body.title) || "").trim();
    if (!seed || !title) {
      return sendJson(req, res, 400, { error: "Wymagane: seed i title" });
    }
    const language = String((req.body && req.body.language) || "en").toLowerCase();
    const payload = {
      seed,
      title,
      metaDescription: String((req.body && req.body.metaDescription) || "").trim(),
      analysis: (req.body && req.body.analysis) || fallbackWsadAnalysis(seed, language),
      targetWords: Number(req.body && (req.body.targetWords || req.body.targetChars)) || 2000,
      language
    };

    // Async job — unika 504 na Hostingerze (proxy timeout przy długim Bedrock)
    const jobId = "wsad-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    wsadJobs.set(jobId, {
      status: "running",
      step: "starting",
      createdAt: Date.now(),
      userId: auth.user.id
    });
    cleanupWsadJobs();
    sendJson(req, res, 202, { jobId: jobId, status: "running" });

    setImmediate(async function () {
      try {
        const post = await wsadGenerateWithAi(Object.assign({}, payload, {
          onProgress: function (step) {
            const cur = wsadJobs.get(jobId) || {};
            wsadJobs.set(jobId, Object.assign({}, cur, {
              status: "running",
              step: step,
              createdAt: cur.createdAt || Date.now(),
              userId: auth.user.id
            }));
          }
        }));
        wsadJobs.set(jobId, {
          status: "done",
          step: "done",
          post: post,
          provider: "bedrock",
          createdAt: Date.now(),
          userId: auth.user.id
        });
      } catch (err) {
        console.warn("WSAD generate fallback:", err.message);
        wsadJobs.set(jobId, {
          status: "done",
          step: "done",
          post: fallbackWsadPost(payload),
          provider: "fallback",
          warning: err.message || "Bedrock niedostępny — użyto szablonu lokalnego",
          createdAt: Date.now(),
          userId: auth.user.id
        });
      }
    });
  });

  app.get("/api/wsad/generate/:jobId", function (req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const job = wsadJobs.get(String(req.params.jobId || ""));
    if (!job) return sendJson(req, res, 404, { error: "Nie znaleziono joba generowania" });
    if (job.userId && job.userId !== auth.user.id) {
      return sendJson(req, res, 403, { error: "Brak dostępu do tego joba" });
    }
    sendJson(req, res, 200, {
      jobId: req.params.jobId,
      status: job.status,
      step: job.step || "",
      post: job.post || null,
      provider: job.provider || null,
      warning: job.warning || null,
      error: job.error || null
    });
  });

  app.get("*", function (req, res) {
    let filePath = safeStaticPath(req.path);
    if (filePath && serveStatic(req, res, filePath)) return;
    // katalog /wsad/ → index (gdy ktoś wejdzie głębiej bez pliku)
    if (req.path === "/wsad" || req.path === "/wsad/") {
      filePath = path.join(__dirname, "wsad", "index.html");
      if (serveStatic(req, res, filePath)) return;
    }
    if (req.path === "/" || !path.extname(req.path)) {
      filePath = safeStaticPath("/index.html");
      if (filePath && serveStatic(req, res, filePath)) return;
    }
    sendJson(req, res, 404, { error: "Not found" });
  });

  return app;
}
