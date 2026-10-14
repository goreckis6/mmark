import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_URL = "https://useme.com/pl/jobs/category/serwisy-internetowe,34/";
const DEFAULT_DATA_PATH = path.join(__dirname, "data", "useme-scraper.json");
const MAX_STORED_JOBS = 2000;
const JOBS_PER_PAGE = 20;

let activeRun = null;
let schedulerStarted = false;
let schedulerTimer = null;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function envInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function emptyState() {
  return {
    version: 1,
    initialized: false,
    jobs: [],
    sentIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastPagesScanned: 0,
    lastJobsFound: 0,
    lastNewJobs: 0,
    lastEmailAt: null,
    lastEmailCount: 0
  };
}

function readState(dataPath = DEFAULT_DATA_PATH) {
  try {
    if (!fs.existsSync(dataPath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    return {
      ...emptyState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      sentIds: Array.isArray(parsed.sentIds) ? parsed.sentIds.map(String) : []
    };
  } catch (error) {
    console.warn("Useme scraper: nie można odczytać bazy:", error.message);
    return emptyState();
  }
}

function writeState(state, dataPath = DEFAULT_DATA_PATH) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const tmpPath = `${dataPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, dataPath);
}

function decodeHtml(value) {
  const entities = {
    amp: "&",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
    nbsp: " "
  };
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] || match)
    .replace(/<[^>]+>/g, " ")
    .replace(/\\([\\[\]()_*])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeJob(title, href, page) {
  let url;
  try {
    url = new URL(href, "https://useme.com");
  } catch {
    return null;
  }
  if (url.hostname !== "useme.com" && url.hostname !== "www.useme.com") return null;
  const match = url.pathname.match(/^\/pl\/jobs\/[^/]+,(\d+)\/$/);
  if (!match) return null;
  const cleanTitle = decodeHtml(title);
  if (!cleanTitle || cleanTitle.length < 3) return null;
  url.protocol = "https:";
  url.hostname = "useme.com";
  url.search = "";
  url.hash = "";
  return { id: match[1], title: cleanTitle, url: url.toString(), page };
}

export function parseUsemeJobs(source, page = 1) {
  const text = String(source || "");
  const found = new Map();
  const markdownLink = /\[([^\]\n]{3,300})\]\((https?:\/\/useme\.com\/pl\/jobs\/[^\s)]+,\d+\/)\)/gi;
  const htmlLink = /<a\b[^>]*href=["'](\/pl\/jobs\/[^"'?]+,\d+\/)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of text.matchAll(markdownLink)) {
    const job = normalizeJob(match[1], match[2], page);
    if (job) found.set(job.id, job);
  }
  for (const match of text.matchAll(htmlLink)) {
    const job = normalizeJob(match[2], match[1], page);
    if (job) found.set(job.id, job);
  }
  return [...found.values()];
}

function isChallengePage(text, response) {
  return response.status === 403 || /Just a moment|cf-chl-|Enable JavaScript and cookies/i.test(text);
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: options.headers || {}
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

function pageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  return url.toString();
}

async function fetchUsemePage(sourceUrl, page) {
  const target = pageUrl(sourceUrl, page);
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.7",
    "User-Agent": `Mozilla/5.0 (compatible; RekinyBiznesuBot/1.0; +${process.env.PUBLIC_SITE_URL || "https://rekinybiznesu.shop"})`
  };

  let directError = null;
  try {
    const direct = await fetchText(target, { headers });
    const jobs = parseUsemeJobs(direct.text, page);
    if (direct.response.ok && !isChallengePage(direct.text, direct.response) && jobs.length) {
      return { jobs, provider: "useme" };
    }
    directError = new Error(`Useme HTTP ${direct.response.status}; ofert: ${jobs.length}`);
  } catch (error) {
    directError = error;
  }

  const readerUrl = `https://r.jina.ai/http://${target.replace(/^https?:\/\//, "")}`;
  try {
    const reader = await fetchText(readerUrl, {
      timeoutMs: 40000,
      headers: {
        Accept: "text/markdown",
        "X-No-Cache": "true",
        "X-Return-Format": "markdown",
        "User-Agent": headers["User-Agent"]
      }
    });
    const jobs = parseUsemeJobs(reader.text, page);
    if (!reader.response.ok || !jobs.length) {
      throw new Error(`Reader HTTP ${reader.response.status}; ofert: ${jobs.length}`);
    }
    return { jobs, provider: "jina-reader" };
  } catch (readerError) {
    throw new Error(`Strona ${page}: ${directError?.message || "Useme niedostępne"}; ${readerError.message}`);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function smtpConfig() {
  return {
    host: String(process.env.SMTP_HOST || "").trim(),
    port: envInt("SMTP_PORT", 465, 1, 65535),
    user: String(process.env.SMTP_USER || "").trim(),
    pass: String(process.env.SMTP_PASS || ""),
    from: String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
    to: String(process.env.SCRAPER_EMAIL_TO || "slavomir.gorecki@gmail.com").trim()
  };
}

export function isEmailConfigured() {
  const config = smtpConfig();
  return Boolean(config.host && config.user && config.pass && config.from && config.to);
}

function createSmtpReader(socket) {
  let buffer = "";
  const waiters = [];
  let terminalError = null;

  function pump() {
    while (waiters.length) {
      const lines = buffer.split(/\r?\n/);
      let endIndex = -1;
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (/^\d{3} /.test(lines[index])) endIndex = index;
      }
      if (endIndex === -1) break;
      const responseLines = lines.slice(0, endIndex + 1);
      buffer = lines.slice(endIndex + 1).join("\r\n");
      waiters.shift().resolve(responseLines.join("\n"));
    }
  }

  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    pump();
  });
  socket.on("error", error => {
    terminalError = error;
    while (waiters.length) waiters.shift().reject(error);
  });
  socket.on("close", () => {
    const error = terminalError || new Error("Połączenie SMTP zostało zamknięte");
    while (waiters.length) waiters.shift().reject(error);
  });

  return function readResponse() {
    return new Promise((resolve, reject) => {
      if (terminalError) return reject(terminalError);
      waiters.push({ resolve, reject });
      pump();
    });
  };
}

async function sendCommand(socket, readResponse, command, expected) {
  if (command) socket.write(command + "\r\n");
  const response = await readResponse();
  const code = Number.parseInt(response.slice(0, 3), 10);
  if (!expected.includes(code)) throw new Error(`SMTP ${code}: ${response.replace(/\s+/g, " ").slice(0, 240)}`);
  return response;
}

function dotStuff(value) {
  return String(value).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

async function sendSmtpMail({ subject, text, html }) {
  const config = smtpConfig();
  if (!isEmailConfigured()) throw new Error("Brak pełnej konfiguracji SMTP");

  const socket = tls.connect({
    host: config.host,
    port: config.port,
    servername: config.host,
    rejectUnauthorized: true
  });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  socket.setTimeout(30000, () => socket.destroy(new Error("Timeout SMTP")));
  const readResponse = createSmtpReader(socket);

  try {
    await sendCommand(socket, readResponse, null, [220]);
    await sendCommand(socket, readResponse, `EHLO ${new URL(process.env.PUBLIC_SITE_URL || "https://rekinybiznesu.shop").hostname}`, [250]);
    await sendCommand(socket, readResponse, "AUTH LOGIN", [334]);
    await sendCommand(socket, readResponse, Buffer.from(config.user).toString("base64"), [334]);
    await sendCommand(socket, readResponse, Buffer.from(config.pass).toString("base64"), [235]);
    await sendCommand(socket, readResponse, `MAIL FROM:<${config.from}>`, [250]);
    await sendCommand(socket, readResponse, `RCPT TO:<${config.to}>`, [250, 251]);
    await sendCommand(socket, readResponse, "DATA", [354]);

    const boundary = `rekiny-${Date.now().toString(36)}`;
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
    const message = [
      `From: ${config.from}`,
      `To: ${config.to}`,
      `Subject: ${encodedSubject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@rekinybiznesu.shop>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      "",
      `--${boundary}--`
    ].join("\r\n");
    socket.write(dotStuff(message) + "\r\n.\r\n");
    await sendCommand(socket, readResponse, null, [250]);
    await sendCommand(socket, readResponse, "QUIT", [221]);
  } finally {
    socket.end();
  }
}

async function notifyNewJobs(jobs) {
  const count = jobs.length;
  const subject = `Useme: ${count} ${count === 1 ? "nowe zlecenie" : "nowych zleceń"}`;
  const text = [
    `Nowe zlecenia Useme (${count}):`,
    "",
    ...jobs.flatMap(job => [job.title, job.url, ""]),
    `Panel: ${(process.env.PUBLIC_SITE_URL || "https://rekinybiznesu.shop").replace(/\/$/, "")}/scraper`
  ].join("\n");
  const items = jobs.map(job => `<li style=\"margin:0 0 14px\"><a href=\"${escapeHtml(job.url)}\" style=\"color:#0b6bcb;font-weight:700\">${escapeHtml(job.title)}</a><br><span style=\"color:#64748b;font-size:13px\">${escapeHtml(job.url)}</span></li>`).join("");
  const html = `<div style=\"font-family:Arial,sans-serif;max-width:720px;margin:auto;color:#172033\"><h2>Nowe zlecenia Useme (${count})</h2><ul style=\"padding-left:22px\">${items}</ul><p><a href=\"${escapeHtml((process.env.PUBLIC_SITE_URL || "https://rekinybiznesu.shop").replace(/\/$/, "") + "/scraper")}\">Otwórz panel scrapera</a></p></div>`;
  await sendSmtpMail({ subject, text, html });
}

function sortJobs(jobs) {
  return jobs.sort((a, b) => Number(b.id) - Number(a.id));
}

export async function runUsemeScraper(options = {}) {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    const dataPath = options.dataPath || process.env.SCRAPER_DATA_FILE || DEFAULT_DATA_PATH;
    const maxPages = options.maxPages || envInt("SCRAPER_MAX_PAGES", 10, 1, 10);
    const pageDelayMs = options.pageDelayMs ?? envInt("SCRAPER_PAGE_DELAY_SECONDS", 10, 1, 30) * 1000;
    const sourceUrl = String(process.env.USEME_SOURCE_URL || DEFAULT_SOURCE_URL).trim();
    const state = readState(dataPath);
    const startedAt = new Date().toISOString();
    const allFound = new Map();
    const providers = new Set();
    const pageErrors = [];

    state.lastRunAt = startedAt;
    state.lastError = null;

    for (let page = 1; page <= maxPages; page += 1) {
      try {
        const result = await fetchUsemePage(sourceUrl, page);
        providers.add(result.provider);
        for (const job of result.jobs) allFound.set(job.id, job);
      } catch (error) {
        pageErrors.push(error.message);
      }
      if (page < maxPages) await wait(pageDelayMs);
    }

    if (!allFound.size) {
      state.lastError = pageErrors.join(" | ") || "Nie znaleziono żadnych ofert";
      state.updatedAt = new Date().toISOString();
      writeState(state, dataPath);
      throw new Error(state.lastError);
    }

    const now = new Date().toISOString();
    const existing = new Map(state.jobs.map(job => [String(job.id), job]));
    const newlyDiscovered = [];
    for (const job of allFound.values()) {
      const previous = existing.get(job.id);
      if (!previous) newlyDiscovered.push(job);
      existing.set(job.id, {
        ...previous,
        ...job,
        foundAt: previous?.foundAt || now,
        lastSeenAt: now
      });
    }
    state.jobs = sortJobs([...existing.values()]).slice(0, MAX_STORED_JOBS);

    const sentIds = new Set(state.sentIds.map(String));
    let emailSent = 0;
    let emailError = null;
    if (!state.initialized) {
      for (const job of allFound.values()) sentIds.add(job.id);
      state.initialized = true;
    } else {
      const pending = sortJobs(state.jobs.filter(job => !sentIds.has(String(job.id))));
      if (pending.length && options.notify !== false) {
        if (isEmailConfigured()) {
          try {
            await notifyNewJobs(pending);
            for (const job of pending) sentIds.add(String(job.id));
            emailSent = pending.length;
            state.lastEmailAt = now;
            state.lastEmailCount = pending.length;
          } catch (error) {
            emailError = error.message;
          }
        } else {
          emailError = "Brak konfiguracji SMTP — nowe oferty czekają na wysłanie";
        }
      }
    }

    state.sentIds = [...sentIds].slice(-MAX_STORED_JOBS * 2);
    state.updatedAt = now;
    state.lastSuccessAt = now;
    state.lastPagesScanned = maxPages - pageErrors.length;
    state.lastJobsFound = allFound.size;
    state.lastNewJobs = newlyDiscovered.length;
    state.lastError = [pageErrors.length ? pageErrors.join(" | ") : "", emailError || ""].filter(Boolean).join(" | ") || null;
    writeState(state, dataPath);

    return {
      ok: true,
      pagesScanned: state.lastPagesScanned,
      jobsFound: allFound.size,
      newJobs: newlyDiscovered.length,
      emailSent,
      pendingEmail: state.jobs.filter(job => !sentIds.has(String(job.id))).length,
      providers: [...providers],
      warnings: state.lastError ? [state.lastError] : []
    };
  })();

  try {
    return await activeRun;
  } finally {
    activeRun = null;
  }
}

export function getUsemeScraperStatus(options = {}) {
  const dataPath = options.dataPath || process.env.SCRAPER_DATA_FILE || DEFAULT_DATA_PATH;
  const state = readState(dataPath);
  const sentIds = new Set(state.sentIds.map(String));
  return {
    enabled: envBool("SCRAPER_ENABLED", true),
    running: Boolean(activeRun),
    intervalMinutes: envInt("SCRAPER_INTERVAL_MINUTES", 5, 1, 1440),
    maxPages: envInt("SCRAPER_MAX_PAGES", 10, 1, 10),
    sourceUrl: String(process.env.USEME_SOURCE_URL || DEFAULT_SOURCE_URL),
    emailTo: String(process.env.SCRAPER_EMAIL_TO || "slavomir.gorecki@gmail.com"),
    emailConfigured: isEmailConfigured(),
    totalJobs: state.jobs.length,
    pendingEmail: state.jobs.filter(job => !sentIds.has(String(job.id))).length,
    initialized: state.initialized,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    lastPagesScanned: state.lastPagesScanned,
    lastJobsFound: state.lastJobsFound,
    lastNewJobs: state.lastNewJobs,
    lastEmailAt: state.lastEmailAt,
    lastEmailCount: state.lastEmailCount
  };
}

export function getUsemeJobs({ page = 1, pageSize = JOBS_PER_PAGE, dataPath } = {}) {
  const state = readState(dataPath || process.env.SCRAPER_DATA_FILE || DEFAULT_DATA_PATH);
  const safePage = Math.min(10, Math.max(1, Number.parseInt(page, 10) || 1));
  const safePageSize = Math.min(200, Math.max(1, Number.parseInt(pageSize, 10) || JOBS_PER_PAGE));
  const start = (safePage - 1) * safePageSize;
  return {
    jobs: state.jobs.slice(start, start + safePageSize),
    page: safePage,
    pageSize: safePageSize,
    total: state.jobs.length,
    totalPages: Math.min(10, Math.max(1, Math.ceil(state.jobs.length / safePageSize)))
  };
}

export function startUsemeScraperScheduler() {
  if (schedulerStarted || !envBool("SCRAPER_ENABLED", true)) return;
  schedulerStarted = true;
  const intervalMs = envInt("SCRAPER_INTERVAL_MINUTES", 5, 1, 1440) * 60 * 1000;
  const initialDelayMs = envInt("SCRAPER_INITIAL_DELAY_SECONDS", 8, 1, 300) * 1000;

  const execute = () => {
    runUsemeScraper().catch(error => console.warn("Useme scraper:", error.message));
  };
  const initialTimer = setTimeout(execute, initialDelayMs);
  initialTimer.unref?.();
  schedulerTimer = setInterval(execute, intervalMs);
  schedulerTimer.unref?.();
}

export function stopUsemeScraperScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}
