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
      "# " + t + "\n\n" +
      (metaDescription || "") + "\n\n" +
      "This article gives a practical overview of **" + s + "**: what it is, how to approach it in 2026, and which takeaways actually help decision-making.\n\n" +
      "## Table of contents\n\n" +
      "1. What " + s + " is\n" +
      "2. How " + s + " works in practice\n" +
      "3. Common mistakes\n" +
      "4. Key takeaways\n\n" +
      "## Key takeaways\n\n" +
      "- Match search intent: people looking for \"" + s + "\" usually want a definition plus actionable tips.\n" +
      "- Build topical coverage with related queries (" + (kws.slice(1, 4).join(", ") || "long-tail phrases") + ").\n" +
      "- Mix low/medium/high KD keywords instead of chasing only the hardest head term.\n" +
      "- Be concrete: examples, checklists, and clear takeaways improve ranking potential.\n\n" +
      "## What " + s + " is\n\n" +
      s.charAt(0).toUpperCase() + s.slice(1) +
      " is a topic worth defining early, then expanding with context and use cases. Strong SEO writing combines natural language with related entities instead of stuffing exact-match phrases.\n\n" +
      "## How " + s + " works in practice\n\n" +
      "Start from the reader's problem, then explain the mechanism and examples. Weave in related phrases (" +
      (kws.join(", ") || s) +
      ") while staying readable. In 2026 SEO, intent fit, E-E-A-T signals, structured takeaways, and AI Overview-friendly formatting all matter.\n\n" +
      "## Common mistakes\n\n" +
      "1. Targeting only high-KD terms with no long-tail support.\n" +
      "2. Skipping a table of contents and key takeaways.\n" +
      "3. Vague advice with no concrete steps.\n" +
      "4. Keyword stuffing that hurts clarity.\n\n" +
      "Bottom line: a well-optimized article about **" + s + "** balances readability, keyword mix, and structure that helps both users and search engines.";

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
  const text = await invokeBedrock({ system, prompt, maxTokens: 4500 });
  const parsed = extractJsonObject(text);
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
  const text = await invokeBedrock({ system, prompt, maxTokens: 1200 });
  const parsed = extractJsonObject(text);
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

async function wsadGenerateWithAi(payload) {
  const seed = payload.seed;
  const title = payload.title;
  const meta = payload.metaDescription || "";
  const analysis = payload.analysis || {};
  const target = Number(payload.targetChars) || 2000;
  const lang = (payload.language || "en").toLowerCase();
  const kws = (analysis.keywords || []).map(function (k) { return k.term + " [" + k.kd + "]"; }).join("; ");
  const system =
    "You are an SEO copywriter for 2026. Write naturally in " +
    (lang === "pl" ? "Polish" : "English") +
    ", without keyword stuffing, with strong semantic coverage (entities, synonyms, PAA). " +
    "Return ONLY JSON.";
  const prompt =
    "Generate a blog post.\n" +
    "Language: " + lang + "\n" +
    "Seed: " + seed + "\n" +
    "Title: " + title + "\n" +
    "Meta: " + meta + "\n" +
    "Keywords (use a mix): " + kws + "\n" +
    "Outline: " + JSON.stringify(analysis.outline || []) + "\n" +
    "Target contentMd length: " + target + " characters (±15%).\n\n" +
    "contentMd Markdown structure:\n" +
    "1) Short intro answering search intent\n" +
    "2) ## Table of contents\n" +
    "3) ## Key takeaways (3-5 bullets)\n" +
    "4) Topic expansion in H2/H3 with keywords\n" +
    "5) Closing CTA\n\n" +
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
  const text = await invokeBedrock({ system, prompt, maxTokens: 5000 });
  const parsed = extractJsonObject(text);
  if (!parsed.contentMd) throw new Error("Missing contentMd in model response");
  parsed.slug = parsed.slug || slugifyPl(parsed.title || title);
  parsed.charCount = parsed.charCount || countVisibleChars(parsed.contentMd);
  parsed.wordCount = parsed.wordCount || parsed.contentMd.trim().split(/\s+/).length;
  return parsed;
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
      targetChars: Number(req.body && req.body.targetChars) || 2000,
      language
    };
    try {
      const post = await wsadGenerateWithAi(payload);
      sendJson(req, res, 200, { post, provider: "bedrock" });
    } catch (err) {
      console.warn("WSAD generate fallback:", err.message);
      sendJson(req, res, 200, {
        post: fallbackWsadPost(payload),
        provider: "fallback",
        warning: err.message || "Bedrock niedostępny — użyto szablonu lokalnego"
      });
    }
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
