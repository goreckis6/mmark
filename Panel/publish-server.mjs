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

function fallbackWsadAnalysis(seed) {
  const s = String(seed || "").trim();
  const keywords = [
    { term: s, kd: estimateKd(s), reason: "Hasło główne — zwykle wyższa konkurencja" },
    { term: s + " — co to jest", kd: "low", reason: "Long-tail definicja, łatwiejsze wejście" },
    { term: "jak " + s + " działa", kd: "low", reason: "Intencja informacyjna, niski KD" },
    { term: s + " w praktyce", kd: "medium", reason: "Środek lejka, umiarkowana konkurencja" },
    { term: "najczęstsze błędy " + s, kd: "low", reason: "Problem-aware long-tail" },
    { term: s + " ranking", kd: "high", reason: "Komercyjne / porównawcze — wysoki KD" },
    { term: s + " poradnik 2026", kd: "medium", reason: "Freshness + poradnik, medium KD" },
    { term: "czy warto " + s, kd: "medium", reason: "Decyzyjne zapytanie" }
  ];
  return {
    seed: s,
    intent: "Informacyjna z elementami komercyjnymi — użytkownik chce zrozumieć temat \"" + s + "\" i dostać praktyczne wnioski.",
    primaryKeyword: s,
    keywords,
    titles: [
      {
        title: s + ": kompletny poradnik na 2026 (praktycznie i bez ściemy)",
        rationale: "Rok + obietnica praktyki, dobry CTR"
      },
      {
        title: "Jak działa " + s + "? Wyjaśnienie, przykłady i kluczowe wnioski",
        rationale: "Pytanie w tytule + featured snippet"
      },
      {
        title: s + " — co warto wiedzieć, zanim zaczniesz",
        rationale: "Beginner intent, niższy KD"
      },
      {
        title: "Najczęstsze błędy przy: " + s + " (i jak ich uniknąć)",
        rationale: "Problem-solution, wysoki engagement"
      },
      {
        title: s + " w praktyce: checklista i kluczowe takeaways",
        rationale: "Checklist + AI Overviews friendly"
      }
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
      "Mix KD: 1× high (główne + ranking), 3× medium, 4× low long-tail. Struktura pod AI Overviews: definicja, lista wniosków, jasne H2. Unikaj keyword stuffingu — naturalne powtórzenia frazy głównej + synonimy/entity."
  };
}

function fallbackWsadPost({ seed, title, metaDescription, analysis }) {
  const s = seed || (analysis && analysis.primaryKeyword) || "temat";
  const t = title || (s + " — poradnik");
  const kws = ((analysis && analysis.keywords) || [])
    .map(function (k) { return k.term; })
    .filter(Boolean)
    .slice(0, 6);
  const body =
    "# " + t + "\n\n" +
    metaDescription + "\n\n" +
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
    " to temat, wokół którego warto zebrać definicję, kontekst i zastosowania. Dobry wpis łączy język naturalny z frazami kluczowymi, zamiast sztucznego upychania słów. W praktyce liczy się jasna odpowiedź w pierwszych akapitach oraz rozwinięcie pod pytania uzupełniające.\n\n" +
    "## Jak " + s + " działa w praktyce\n\n" +
    "Zacznij od problemu czytelnika, potem przejdź do mechanizmu i przykładów. Wpleć synonimy i frazy pokrewne (" +
    (kws.join(", ") || s) +
    "), ale utrzymuj czytelność. W SEO 2026 pomagają: dopasowanie do intencji, E-E-A-T, strukturyzowane wnioski oraz treści przyjazne AI Overviews.\n\n" +
    "## Najczęstsze błędy\n\n" +
    "1. Celowanie wyłącznie w high KD bez long-tail.\n" +
    "2. Brak spisu treści i key takeaways.\n" +
    "3. Ogólniki zamiast konkretów.\n" +
    "4. Keyword stuffing kosztem sensu.\n\n" +
    "Podsumowując: dobrze zoptymalizowany tekst o **" + s + "** łączy czytelność, mix KD i strukturę, która pomaga zarówno użytkownikowi, jak i wyszukiwarce.";

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

async function wsadAnalyzeWithAi(seed, language) {
  const system =
    "Jesteś strategiem SEO 2026 (Google + AI Overviews). " +
    "Oceniasz trudność słów kluczowych (KD) szacunkowo: low / medium / high. " +
    "Zawsze robisz MIX: część low (long-tail), medium i high. " +
    "Stosujesz: search intent, E-E-A-T, entity SEO, featured snippets, People Also Ask, naturalny język. " +
    "Zwracasz WYŁĄCZNIE poprawny JSON bez komentarza.";
  const prompt =
    "Język: " + (language || "pl") + "\n" +
    "Hasło seed: \"" + seed + "\"\n\n" +
    "Zrób analizę pod wpis blogowy. Schema JSON:\n" +
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
    "Wymagania: 7-10 keywords (mix KD), 5 titles pod CTR 2026, outline 5-7 H2, meta ~150-160 znaków.";
  const text = await invokeBedrock({ system, prompt, maxTokens: 3500 });
  const parsed = extractJsonObject(text);
  if (!parsed.keywords || !parsed.keywords.length) {
    parsed.keywords = fallbackWsadAnalysis(seed).keywords;
  }
  parsed.keywords = parsed.keywords.map(function (kw) {
    return {
      term: kw.term || kw.keyword || seed,
      kd: String(kw.kd || estimateKd(kw.term || seed)).toLowerCase(),
      reason: kw.reason || kw.intent || ""
    };
  });
  return parsed;
}

async function wsadGenerateWithAi(payload) {
  const seed = payload.seed;
  const title = payload.title;
  const meta = payload.metaDescription || "";
  const analysis = payload.analysis || {};
  const target = Number(payload.targetChars) || 2000;
  const kws = (analysis.keywords || []).map(function (k) { return k.term + " [" + k.kd + "]"; }).join("; ");
  const system =
    "Jesteś copywriterem SEO 2026 po polsku. Piszesz naturalnie, bez keyword stuffingu, " +
    "z dużą gęstością semantyczną (encje, synonimy, PAA). " +
    "Zwracasz WYŁĄCZNIE JSON.";
  const prompt =
    "Wygeneruj wpis blogowy.\n" +
    "Seed: " + seed + "\n" +
    "Tytuł: " + title + "\n" +
    "Meta: " + meta + "\n" +
    "Keywords (użyj mixu): " + kws + "\n" +
    "Outline: " + JSON.stringify(analysis.outline || []) + "\n" +
    "Cel długości contentMd: " + target + " znaków (±15%), bez liczenia spacji wielokrotnych.\n\n" +
    "Struktura contentMd (Markdown):\n" +
    "1) Krótki wstęp (intro z odpowiedzią na intencję)\n" +
    "2) ## Spis treści\n" +
    "3) ## Key takeaways (3-5 bulletów)\n" +
    "4) Rozwinięcie tematu w H2/H3 z frazami kluczowymi\n" +
    "5) Zakończenie z CTA do dalszej lektury\n\n" +
    "Schema JSON:\n" +
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
  if (!parsed.contentMd) throw new Error("Brak contentMd w odpowiedzi");
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
    try {
      const analysis = await wsadAnalyzeWithAi(seed, req.body.language || "pl");
      sendJson(req, res, 200, { analysis, provider: "bedrock" });
    } catch (err) {
      console.warn("WSAD analyze fallback:", err.message);
      sendJson(req, res, 200, {
        analysis: fallbackWsadAnalysis(seed),
        provider: "fallback",
        warning: err.message || "Bedrock niedostępny — użyto analizy lokalnej"
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
    const payload = {
      seed,
      title,
      metaDescription: String((req.body && req.body.metaDescription) || "").trim(),
      analysis: (req.body && req.body.analysis) || fallbackWsadAnalysis(seed),
      targetChars: Number(req.body && req.body.targetChars) || 2000,
      language: (req.body && req.body.language) || "pl"
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
