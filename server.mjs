import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizePowerSmartMonthly } from "./lib/powersmart-normalize.mjs";
import pg from "pg";
import webpush from "web-push";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = join(__dirname, "app");
const PORT = Number(process.env.PORT || 10000);

// V37 LOGGER REASSIGNMENT
// The Wi-Fi logger that was previously named PV14000 is now physically fitted
// to PV9000. Existing Render variables keep working: PV14000_API_BASE / META_API_BASE
// are treated as the reassigned PV9000 logger until a dedicated PV9000 URL is set.
const LEGACY_WIFI_API_BASE = String(
  process.env.PV14000_API_BASE ||
  process.env.META_API_BASE ||
  "https://inverterzone-dashboard.onrender.com"
).replace(/\/$/, "");
const LEGACY_WIFI_USER = String(
  process.env.PV14000_DASHBOARD_USER || process.env.META_DASHBOARD_USER || "admin"
).trim() || "admin";
const LEGACY_WIFI_PASSWORD = String(
  process.env.PV14000_DASHBOARD_PASSWORD || process.env.META_DASHBOARD_PASSWORD || ""
);

// SYSTEM 01 - PV14000 remains physically installed, but its live telemetry is
// intentionally disabled until a new logger is ordered and configured here.
const PV14000_API_BASE = String(process.env.PV14000_NEW_API_BASE || "").replace(/\/$/, "");
const PV14000_USER = String(process.env.PV14000_NEW_DASHBOARD_USER || LEGACY_WIFI_USER).trim() || "admin";
const PV14000_PASSWORD = String(process.env.PV14000_NEW_DASHBOARD_PASSWORD || LEGACY_WIFI_PASSWORD);

// SYSTEM 02 - PV9000 now owns the reassigned Wi-Fi logger.
const PV9000_API_BASE = String(process.env.PV9000_API_BASE || LEGACY_WIFI_API_BASE).replace(/\/$/, "");
const PV9000_USER = String(process.env.PV9000_DASHBOARD_USER || LEGACY_WIFI_USER).trim() || "admin";
const PV9000_PASSWORD = String(process.env.PV9000_DASHBOARD_PASSWORD || LEGACY_WIFI_PASSWORD);

// SYSTEM 03 - Fronus Matrix 6kW, now used as a PV-less UPS.
const MATRIX_API_BASE = String(
  process.env.MATRIX_API_BASE || "https://fronus-matrix-dashboard.onrender.com"
).replace(/\/$/, "");

// Independent physical utility meter. This is intentionally separate from the
// inverter grid calculations so both readings can be compared on the Master UI.
const TUYA_API_BASE = String(
  process.env.TUYA_API_BASE || "https://tuya-meter-dashboard.onrender.com"
).replace(/\/$/, "");

const RATE = Number(process.env.ELECTRICITY_RATE_PKR || 60);
const EXPORT_RATE = Math.max(0, Number(process.env.EXPORT_RATE_PKR || 0));
const NIGHT_IMPORT_LIMIT_W = Math.max(100, Number(process.env.NIGHT_IMPORT_LIMIT_W || 5000));
const DAY_EXPORT_LIMIT_W = Math.max(100, Number(process.env.DAY_EXPORT_LIMIT_W || 6000));
const DAY_MODE_START = String(process.env.DAY_MODE_START || "07:30").trim();
const DAY_MODE_END = String(process.env.DAY_MODE_END || "17:00").trim();
const BATTERY_CAPACITY_KWH = Math.max(0, Number(process.env.BATTERY_CAPACITY_KWH || 0));
const TARGET_DAILY_YIELD_KWH_PER_KWP = Math.max(0, Number(process.env.TARGET_DAILY_YIELD_KWH_PER_KWP || 0));
const RECONCILIATION_ALERT_W = Math.max(100, Number(process.env.RECONCILIATION_ALERT_W || 500));
const ALERT_TEMP_C = Math.max(30, Number(process.env.ALERT_TEMP_C || 65));
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const HISTORY_SAMPLE_SECONDS = Math.max(30, Number(process.env.HISTORY_SAMPLE_SECONDS || 60));

// Power Smart / PITC account bridge. This integration intentionally uses only
// the owner's normal Power Smart account session. No shared or extracted MDM
// service credential is embedded in this project.
const POWER_SMART_APP_BASE = "https://api-powersmart.pitc.com.pk";
const POWER_SMART_SESSION_HOURS = Math.max(1, Math.min(24, Number(process.env.POWER_SMART_SESSION_HOURS || 8)));
const POWER_SMART_SESSION_MS = POWER_SMART_SESSION_HOURS * 60 * 60 * 1000;
const POWER_SMART_CACHE_MS = Math.max(30_000, Number(process.env.POWER_SMART_CACHE_SECONDS || 120) * 1000);
const powerSmartSessions = new Map();
const powerSmartSignInAttempts = new Map();

// Optional AI Copilot. Gemini is the zero-cost/default provider when a
// GEMINI_API_KEY is configured. OpenAI remains an optional fallback. Keys never
// reach the browser; all model calls are made server-side. A dashboard PIN is
// recommended because Render dashboard URLs can be publicly reachable.
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim() || "gemini-3.1-flash-lite";
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-5.6").trim() || "gpt-5.6";
const AI_ACCESS_PIN = String(process.env.AI_ACCESS_PIN || "").trim();
const AI_MAX_OUTPUT_TOKENS = Math.max(250, Math.min(1800, Number(process.env.AI_MAX_OUTPUT_TOKENS || 900)));
const AI_RATE_LIMIT_REQUESTS = Math.max(3, Math.min(60, Number(process.env.AI_RATE_LIMIT_REQUESTS || 12)));
const AI_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const aiRateState = new Map();

// Optional multi-channel alert delivery. Telegram is the easiest free remote
// channel. Twilio can deliver SMS and WhatsApp when its credentials/senders are
// configured. Standards-based Web Push uses VAPID and works independently of
// Gemini/OpenAI. No notification channel is allowed to control electrical gear.
const NOTIFY_ACCESS_PIN = String(process.env.NOTIFY_ACCESS_PIN || AI_ACCESS_PIN || "").trim();
const ALERT_COOLDOWN_MINUTES = Math.max(2, Number(process.env.ALERT_COOLDOWN_MINUTES || 30));
const ALERT_COOLDOWN_MS = ALERT_COOLDOWN_MINUTES * 60 * 1000;
const ALERT_STALE_SECONDS = Math.max(60, Number(process.env.ALERT_STALE_SECONDS || 180));
const BATTERY_LOW_PCT = Math.max(5, Math.min(80, Number(process.env.BATTERY_LOW_PCT || 20)));
const NOTIFY_DASHBOARD_URL = String(process.env.NOTIFY_DASHBOARD_URL || "https://raja-fraz-master-dashboard.onrender.com").trim();

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();

const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_SMS_FROM = String(process.env.TWILIO_SMS_FROM || "").trim();
const TWILIO_SMS_TO = String(process.env.TWILIO_SMS_TO || "").trim();
const TWILIO_WHATSAPP_FROM = String(process.env.TWILIO_WHATSAPP_FROM || "").trim();
const TWILIO_WHATSAPP_TO = String(process.env.TWILIO_WHATSAPP_TO || "").trim();
const TWILIO_WHATSAPP_CONTENT_SID = String(process.env.TWILIO_WHATSAPP_CONTENT_SID || "").trim();

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || NOTIFY_DASHBOARD_URL).trim();
let webPushConfigured = false;
try {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    webPushConfigured = true;
  }
} catch (error) {
  console.error("Web Push VAPID configuration:", error.message);
}
const pushSubscriptionsMemory = new Map();
const alertDeliveryState = new Map();
let notificationCheckInFlight = null;

// Topology rules. Default values match the user's current wiring:
// PV9000 output feeds Matrix AC input, therefore Matrix load is downstream and
// must not be added again to site demand. Smart Load is directly on PV9000.
const PV9000_LOAD_INCLUDES_UPS = String(process.env.PV9000_LOAD_INCLUDES_UPS || "true").toLowerCase() !== "false";
const PV9000_LOAD_INCLUDES_SMART = String(process.env.PV9000_LOAD_INCLUDES_SMART || "false").toLowerCase() === "true";

const PV14000_PV_INSTALLED_W = 6780;
const PV14000_AC_CAPACITY_W = 10000;
const PV9000_PV_INSTALLED_W = 4360;
const PV9000_AC_CAPACITY_W = 6000;
const MATRIX_AC_CAPACITY_W = 6000;
const TOTAL_PV_INSTALLED_W = PV14000_PV_INSTALLED_W + PV9000_PV_INSTALLED_W;
const CURRENT_MONITORED_PV_W = PV9000_PV_INSTALLED_W + (PV14000_API_BASE ? PV14000_PV_INSTALLED_W : 0);
const SITE_UPSTREAM_AC_CAPACITY_W = PV14000_AC_CAPACITY_W + PV9000_AC_CAPACITY_W;
const EXPECTED_MONITORED_SYSTEMS = PV14000_API_BASE ? 3 : 2;

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 }) : null;
let dbReady = false;
let lastStoredAt = 0;
let lastLiveCache = null;
let lastLiveCacheAt = 0;
let tuyaDirectionState = { importKwh: null, exportKwh: null, mode: "IDLE", lastDirectionAt: 0 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
function readJsonBody(req, maxBytes = 32768) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Request body is too large");
        error.status = 413;
        rejectBody(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolveBody(text ? JSON.parse(text) : {});
      } catch {
        const error = new Error("Invalid JSON body");
        error.status = 400;
        rejectBody(error);
      }
    });
    req.on("error", rejectBody);
  });
}
function aiClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}
function consumeAiRateLimit(req) {
  const key = aiClientIp(req);
  const now = Date.now();
  const current = aiRateState.get(key);
  if (!current || now - current.startedAt >= AI_RATE_LIMIT_WINDOW_MS) {
    aiRateState.set(key, { startedAt: now, count: 1 });
    return { ok: true, remaining: AI_RATE_LIMIT_REQUESTS - 1 };
  }
  if (current.count >= AI_RATE_LIMIT_REQUESTS) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((AI_RATE_LIMIT_WINDOW_MS - (now - current.startedAt)) / 1000)) };
  }
  current.count += 1;
  return { ok: true, remaining: Math.max(0, AI_RATE_LIMIT_REQUESTS - current.count) };
}
function aiPinAccepted(req) {
  if (!AI_ACCESS_PIN) return true;
  return String(req.headers["x-ai-pin"] || "").trim() === AI_ACCESS_PIN;
}
function aiProviderState() {
  if (GEMINI_API_KEY) return {
    provider: "Gemini",
    model: GEMINI_MODEL,
    fallbackProvider: OPENAI_API_KEY ? "OpenAI" : null,
    fallbackModel: OPENAI_API_KEY ? OPENAI_MODEL : null
  };
  if (OPENAI_API_KEY) return { provider: "OpenAI", model: OPENAI_MODEL, fallbackProvider: null, fallbackModel: null };
  return { provider: null, model: GEMINI_MODEL, fallbackProvider: null, fallbackModel: null };
}
function aiStatus() {
  const state = aiProviderState();
  const configured = Boolean(GEMINI_API_KEY || OPENAI_API_KEY);
  return {
    ok: true,
    configured,
    provider: state.provider,
    model: state.model,
    fallbackProvider: state.fallbackProvider,
    fallbackModel: state.fallbackModel,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    openaiConfigured: Boolean(OPENAI_API_KEY),
    pinRequired: Boolean(AI_ACCESS_PIN),
    readOnly: true,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    note: configured
      ? `${state.provider} AI Copilot is available${state.fallbackProvider ? ` with ${state.fallbackProvider} fallback` : ""}.`
      : "Add GEMINI_API_KEY in Render Environment to enable the free-tier AI Copilot."
  };
}
function num(v, fallback = 0) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replaceAll(",", ""));
  return Number.isFinite(n) ? n : fallback;
}
function unwrap(payload) {
  let v = payload;
  for (let i = 0; i < 8; i++) {
    if (Array.isArray(v) && v.length) { v = v[0]; continue; }
    if (!v || typeof v !== "object") break;
    const key = ["dataDTO", "data", "result", "reading", "telemetry"].find((k) => v[k] && typeof v[k] === "object");
    if (!key) break;
    v = v[key];
  }
  return v && typeof v === "object" ? v : {};
}
function first(source, keys, fallback = 0) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return num(source[key], fallback);
  }
  return fallback;
}
function direction(gridW) {
  if (Math.abs(num(gridW)) < 30) return "IDLE";
  return num(gridW) >= 0 ? "IMPORTING" : "EXPORTING";
}
function parseClockMinutes(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const h = Math.max(0, Math.min(23, Number(match[1])));
  const m = Math.max(0, Math.min(59, Number(match[2])));
  return h * 60 + m;
}
function pakistanClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  const minutes = num(out.hour) * 60 + num(out.minute);
  const start = parseClockMinutes(DAY_MODE_START, 7 * 60 + 30);
  const end = parseClockMinutes(DAY_MODE_END, 17 * 60);
  const dayMode = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return { minutes, dayMode, label: dayMode ? "DAY EXPORT WATCH" : "NIGHT IMPORT WATCH" };
}
function authHeader(user, password) {
  if (!password) return null;
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}
async function getJson(url, { timeoutMs = 16000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Raja-Fraz-Master/6.0", ...headers }
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Render free services can return a temporary HTML loading page while a
      // sleeping upstream service is starting. API calls must never treat that
      // page as a valid zero-value telemetry response.
      const error = new Error(`Upstream API is waking / returned non-JSON (HTTP ${response.status})`);
      error.status = response.status;
      error.code = "UPSTREAM_NOT_READY";
      throw error;
    }
    if (!response.ok) {
      const detail = data?.error || data?.msg || `HTTP ${response.status}`;
      const error = new Error(String(detail).slice(0, 300));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function postJson(url, body, { timeoutMs = 18000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "User-Agent": "Raja-Fraz-Master/38.0",
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(body || {})
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      const error = new Error(`Power Smart returned a non-JSON response (HTTP ${response.status}).`);
      error.status = response.status || 502;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(String(data?.message || data?.error || `HTTP ${response.status}`).slice(0, 260));
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function powerSmartCleanRef(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 20);
}
function powerSmartMaskRef(value) {
  const ref = powerSmartCleanRef(value);
  if (!ref) return "Meter";
  if (ref.length <= 6) return `••${ref.slice(-3)}`;
  return `${ref.slice(0, 3)}•••••••${ref.slice(-4)}`;
}
function powerSmartCookieMap(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}
function powerSmartSetCookie(req, res, id, maxAgeSeconds = Math.round(POWER_SMART_SESSION_MS / 1000)) {
  const secure = String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" || !String(req.headers.host || "").startsWith("localhost");
  res.setHeader("Set-Cookie", `rf_ps=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${secure ? "; Secure" : ""}`);
}
function powerSmartSameOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ""); }
  catch { return false; }
}
function powerSmartSession(req, { touch = true } = {}) {
  const id = powerSmartCookieMap(req).rf_ps;
  if (!id) return null;
  const session = powerSmartSessions.get(id);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now) {
    powerSmartSessions.delete(id);
    return null;
  }
  if (touch) session.expiresAt = now + POWER_SMART_SESSION_MS;
  return session;
}
function powerSmartConsumeSignIn(req) {
  const key = aiClientIp(req);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const current = powerSmartSignInAttempts.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    powerSmartSignInAttempts.set(key, { startedAt: now, count: 1 });
    return { ok: true };
  }
  if (current.count >= 5) return { ok: false, retryAfterSeconds: Math.ceil((windowMs - (now - current.startedAt)) / 1000) };
  current.count += 1;
  return { ok: true };
}
function powerSmartApiRoot(payload) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return { ...payload, ...payload.data };
  return payload && typeof payload === "object" ? payload : {};
}
function powerSmartApiAccepted(payload) {
  const root = powerSmartApiRoot(payload);
  const status = String(root.status ?? root.statusCode ?? "").toLowerCase();
  if (root.success === false || root.ok === false) return false;
  if (["400", "401", "403", "404", "500", "false", "failed", "error"].includes(status)) return false;
  return Boolean(root.token || root.accessToken || root.jwt || ["", "1", "200", "true", "success", "ok"].includes(status));
}
function powerSmartMeters(payload) {
  const root = powerSmartApiRoot(payload);
  const rows = root.tblRegisteredRefNo || root.registeredRefNo || root.meters || root.references || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const ref = powerSmartCleanRef(row?.refNo || row?.referenceNo || row?.reference_number || row?.refNum);
    if (!ref) return null;
    return {
      id: `m${index + 1}`,
      ref,
      refMasked: powerSmartMaskRef(ref),
      category: String(row?.connectionCategory || row?.category || "").slice(0, 80),
      customerIdMasked: powerSmartMaskRef(row?.customerId || ""),
      isDefault: [1, "1", true, "true"].includes(row?.defaultStatus)
    };
  }).filter(Boolean);
}
function powerSmartPublicMeters(session) {
  return session.meters.map(({ id, refMasked, category, customerIdMasked, isDefault }) => ({ id, refMasked, category, customerIdMasked, isDefault }));
}
function powerSmartPublicState(session) {
  if (!session) return {
    ok: true, connected: false, source: "PITC Power Smart account API", sourceMode: "official-account",
    instantMdmAvailable: false, sessionHours: POWER_SMART_SESSION_HOURS
  };
  const selected = session.meters.find((m) => m.id === session.selectedMeterId);
  return {
    ok: true,
    connected: true,
    accountName: session.accountName,
    meters: powerSmartPublicMeters(session),
    selectedMeterId: session.selectedMeterId,
    selectedMeterRef: selected?.refMasked || "Meter",
    selectedCategory: selected?.category || "",
    source: "PITC Power Smart account API",
    sourceMode: "official-account",
    instantMdmAvailable: false,
    lastFetchAt: session.lastFetchAt || null,
    expiresAt: new Date(session.expiresAt).toISOString(),
    sessionHours: POWER_SMART_SESSION_HOURS
  };
}
async function powerSmartSignIn(email, cnic, password) {
  const payload = await postJson(`${POWER_SMART_APP_BASE}/appUser/signin`, {
    emailUserId: String(email || "").trim(), contactNo: "", cnic: powerSmartCleanRef(cnic), password: String(password || "")
  });
  const root = powerSmartApiRoot(payload);
  if (!powerSmartApiAccepted(payload)) {
    const error = new Error(String(root.message || root.error || "Power Smart sign-in failed.").slice(0, 240));
    error.status = 401;
    throw error;
  }
  const token = String(root.token || root.accessToken || root.jwt || "").trim();
  if (!token) {
    const error = new Error("Power Smart signed in but did not return an account token.");
    error.status = 502;
    throw error;
  }
  const meters = powerSmartMeters(payload);
  if (!meters.length) {
    const error = new Error("No registered meter was returned by this Power Smart account.");
    error.status = 422;
    throw error;
  }
  return { token, meters, accountName: String(root.appUserName || root.userName || root.name || "Power Smart User").slice(0, 100) };
}
async function powerSmartMonthlyRequest(session, ref) {
  const url = `${POWER_SMART_APP_BASE}/getHistory/monthlyConsumption`;
  const body = { refNo: ref };
  try {
    return await postJson(url, body, { headers: { Authorization: session.token } });
  } catch (error) {
    if (![401, 403].includes(Number(error.status)) || /^Bearer\s/i.test(session.token)) throw error;
    return postJson(url, body, { headers: { Authorization: `Bearer ${session.token}` } });
  }
}
async function powerSmartFetch(session, { force = false } = {}) {
  if (!force && session.cache && Date.now() - session.lastFetchAt < POWER_SMART_CACHE_MS) return session.cache;
  const meter = session.meters.find((m) => m.id === session.selectedMeterId);
  if (!meter) throw Object.assign(new Error("Selected Power Smart meter is unavailable."), { status: 400 });
  const payload = await powerSmartMonthlyRequest(session, meter.ref);
  if (!powerSmartApiAccepted(payload)) {
    const root = powerSmartApiRoot(payload);
    throw Object.assign(new Error(String(root.message || root.error || "Power Smart monthly data request failed.").slice(0, 240)), { status: 502 });
  }
  const normalized = normalizePowerSmartMonthly(payload);
  session.lastFetchAt = Date.now();
  session.cache = {
    ok: true,
    connected: true,
    meterRef: meter.refMasked,
    category: meter.category,
    accountName: session.accountName,
    ...normalized,
    source: "PITC Power Smart account API",
    sourceMode: "official-account",
    instantMdmAvailable: false,
    refreshedAt: new Date().toISOString(),
    refreshSeconds: Math.round(POWER_SMART_CACHE_MS / 1000),
    note: "Official Power Smart account/billing data. It may update less frequently than the physical Tuya meter."
  };
  return session.cache;
}
async function getDashboardJson(base, path, user, password, options = {}) {
  if (!base) {
    const error = new Error("API base URL is not configured");
    error.code = "NOT_CONFIGURED";
    throw error;
  }
  const auth = authHeader(user, password);
  return getJson(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...(auth ? { Authorization: auth } : {}) }
  });
}
const getPv14000Json = (path, options = {}) => getDashboardJson(PV14000_API_BASE, path, PV14000_USER, PV14000_PASSWORD, options);
const getPv9000Json = (path, options = {}) => getDashboardJson(PV9000_API_BASE, path, PV9000_USER, PV9000_PASSWORD, options);

function normalizeSolarInverter(payload, config) {
  const s = unwrap(payload);
  const solar = first(s, ["solarWatts", "solarW", "pvWatts", "PV_Total_Power"]);
  const load = first(s, ["loadWatts", "acOutW", "loadPower", "AC_out_Watt"]);
  const grid = first(s, ["gridWatts", "gridW", "gridPower", "Grid_Watt"]);
  const batteryPct = first(s, ["batteryPercentage", "battPercent", "batterySoc"], NaN);
  return {
    key: config.key,
    name: config.name,
    model: config.model,
    role: "solar-inverter",
    online: true,
    pvInstalledW: config.pvInstalledW,
    acCapacityW: config.acCapacityW,
    solarW: solar,
    pv1W: first(s, ["pv1Watts", "solarW1", "pv1_power"]),
    pv2W: first(s, ["pv2Watts", "solarW2", "pv2_power"]),
    pv1V: first(s, ["pv1Voltage", "pv1V"]),
    pv2V: first(s, ["pv2Voltage", "pv2V"]),
    pv1A: first(s, ["pv1Ampere", "pv1A"]),
    pv2A: first(s, ["pv2Ampere", "pv2A"]),
    loadW: load,
    gridW: grid,
    gridV: first(s, ["gridVoltage", "gridV", "AC_in_Voltage"]),
    gridHz: first(s, ["gridHz", "gridFrequency"]),
    batteryPct: Number.isFinite(batteryPct) ? batteryPct : null,
    batteryW: first(s, ["batteryPowerWatts", "batteryW"], 0),
    smartLoadW: first(s, ["smartLoadWatts", "smartLoadW", "genPortWatts", "genPowerWatts"], 0),
    acOutW: first(s, ["inverterOutputWatts", "acOutW"], load),
    temp: first(s, ["heatSinkTemperature", "heatSinkDegC", "inverterTemperature"], 0),
    fan: first(s, ["fanSpeed", "fan"], 0),
    signal: first(s, ["signal", "wifiSignal"], 0),
    todaySolar: first(s, ["todaySolar", "solarToday"], 0),
    todayLoad: first(s, ["todayLoad", "loadToday"], 0),
    todayImport: first(s, ["todayGrid", "todayImport", "gridImportToday"], 0),
    todayExport: first(s, ["todayNetGrid", "todayExport", "gridExportToday"], 0),
    todaySmartLoad: first(s, ["todaySmartLoad", "smartLoadToday"], 0),
    health: "Excellent",
    updatedAt: num(s.receivedAt || s.timestamp || Date.now())
  };
}
function normalizePv14000(payload) {
  return normalizeSolarInverter(payload, {
    key: "pv14000",
    name: "FRONUS META 10KW - PV14000",
    model: "PV14000",
    pvInstalledW: PV14000_PV_INSTALLED_W,
    acCapacityW: PV14000_AC_CAPACITY_W
  });
}
function normalizePv9000(payload) {
  const normalized = normalizeSolarInverter(payload, {
    key: "pv9000",
    name: "FRONUS META 6KW - PV9000",
    model: "PV9000",
    pvInstalledW: PV9000_PV_INSTALLED_W,
    acCapacityW: PV9000_AC_CAPACITY_W
  });
  // Only one PV string is connected (8 × 545 W = 4,360 W). Whichever MPPT
  // input the logger reports is normalized into String 1; String 2 is disabled.
  const useSecondInput = num(normalized.pv1W) <= 0 && num(normalized.pv2W) > 0;
  const activeStringW = num(normalized.pv1W) + num(normalized.pv2W) || num(normalized.solarW);
  return {
    ...normalized,
    solarW: num(normalized.solarW) || activeStringW,
    pv1W: activeStringW,
    pv2W: 0,
    pv1V: useSecondInput ? num(normalized.pv2V) : num(normalized.pv1V),
    pv2V: 0,
    pv1A: useSecondInput ? num(normalized.pv2A) : num(normalized.pv1A),
    pv2A: 0,
    activeStrings: 1,
    stringLayout: "1 × 8 panels × 545 W = 4.36 kWp",
    loggerSource: "reassigned-from-pv14000"
  };
}
function normalizeMatrixUps(payload) {
  const s = unwrap(payload);
  const rawAcInputW = first(s, ["gridWatts", "gridW", "gridPower", "PG_Pt1"], 0);
  const batteryPct = first(s, ["batteryPercentage", "battPercent", "batterySoc"], NaN);
  return {
    key: "matrix",
    name: "FRONUS MATRIX 6KW",
    model: "Matrix 6K",
    role: "ups",
    online: true,
    pvInstalledW: 0,
    acCapacityW: MATRIX_AC_CAPACITY_W,
    solarW: 0,
    pv1W: 0,
    pv2W: 0,
    // Matrix grid terminals are now the internal AC feed from PV9000, not utility grid.
    acInputW: Math.abs(rawAcInputW),
    acInputRawW: rawAcInputW,
    acInputV: first(s, ["gridVoltage", "gridV", "G_V_L1", "G_V_LN"]),
    acInputHz: first(s, ["gridHz", "gridFrequency", "PG_F1"], 0),
    loadW: first(s, ["loadWatts", "acOutW", "loadPower"]),
    acOutW: first(s, ["inverterOutputWatts", "acOutW"], 0),
    batteryPct: Number.isFinite(batteryPct) ? batteryPct : null,
    batteryW: first(s, ["batteryPowerWatts", "batteryW"], 0),
    batteryV: first(s, ["batteryVoltage", "batteryV"], 0),
    batteryA: first(s, ["batteryCurrent", "batteryA"], 0),
    batteryMode: String(s.batteryMode || "--"),
    temp: first(s, ["heatSinkTemperature", "radiatorTemperature", "transformerTemperature"], 0),
    transformer: first(s, ["transformerTemperature"], 0),
    radiator: first(s, ["radiatorTemperature"], 0),
    todayLoad: first(s, ["todayLoad"], 0),
    todayCharge: first(s, ["todayBatteryCharge", "todayCharge"], 0),
    todayDischarge: first(s, ["todayBatteryDischarge", "todayDischarge"], 0),
    ignoredSolarW: first(s, ["solarWatts", "solarW"], 0),
    health: "Excellent",
    updatedAt: num(s.receivedAt || s.collectionTime || Date.now())
  };
}

function normalizeTuyaDirectionText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!text) return null;

  // Smart Life / Tuya wording observed on this meter:
  // Consumption = utility grid import, Generate = utility grid export.
  const importValues = new Set([
    "consumption", "consume", "consuming", "import", "importing",
    "grid_import", "from_grid", "buy", "buying"
  ]);
  const exportValues = new Set([
    "generate", "generating", "generation", "export", "exporting",
    "grid_export", "to_grid", "feed_in", "feedin", "selling"
  ]);

  if (importValues.has(text)) return "IMPORTING";
  if (exportValues.has(text)) return "EXPORTING";
  return null;
}

function detectTuyaExplicitDirection(s) {
  // Prefer a dedicated normalized field if the Tuya dashboard ever exposes one.
  const topLevelKeys = [
    "direction", "gridDirection", "powerDirection", "flowDirection",
    "flow", "mode", "status", "workState", "workingState"
  ];
  for (const key of topLevelKeys) {
    if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
    const mode = normalizeTuyaDirectionText(s[key]);
    if (mode) return { mode, source: `tuya-field:${key}`, rawValue: String(s[key]) };
  }

  // /api/meter already returns the Tuya shadow properties as `raw`.
  // Scan PROPERTY VALUES only. Never infer direction from codes such as
  // reverse_energy_total because those codes are always present.
  const raw = Array.isArray(s.raw) ? s.raw : [];
  const directionCodes = new Set([
    "direction", "power_direction", "grid_direction", "flow_direction",
    "power_flow", "energy_flow", "work_direction"
  ]);

  for (const prop of raw) {
    if (!prop || typeof prop !== "object") continue;
    const code = String(prop.code || "").trim().toLowerCase();
    const mode = normalizeTuyaDirectionText(prop.value);
    if (mode) return {
      mode,
      source: `tuya-raw:${code || "unknown"}`,
      rawValue: String(prop.value)
    };

    // Forward/reverse are only trusted on a DP explicitly describing direction.
    if (directionCodes.has(code)) {
      const value = String(prop.value ?? "").trim().toLowerCase();
      if (value === "forward") return { mode: "IMPORTING", source: `tuya-raw:${code}`, rawValue: String(prop.value) };
      if (value === "reverse") return { mode: "EXPORTING", source: `tuya-raw:${code}`, rawValue: String(prop.value) };
    }
  }

  // Some bidirectional Tuya meters expose a signed total active-power DP even
  // though phase_a itself contains an unsigned magnitude. A negative signed
  // total is definitive export; positive is intentionally not assumed to be
  // import unless another direction signal confirms it.
  for (const prop of raw) {
    if (!prop || typeof prop !== "object") continue;
    const code = String(prop.code || "").trim().toLowerCase();
    if (!["power_total", "active_power", "active_power_total", "cur_power"].includes(code)) continue;
    const value = Number(prop.value);
    if (Number.isFinite(value) && value < -30) {
      return { mode: "EXPORTING", source: `tuya-signed-power:${code}`, rawValue: String(prop.value) };
    }
  }

  return null;
}

function tuyaPropertyTimestamp(prop) {
  if (!prop || typeof prop !== "object") return null;
  const candidates = [
    prop.time, prop.timestamp, prop.update_time, prop.updateTime,
    prop.last_update_time, prop.lastUpdateTime, prop.event_time, prop.eventTime
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      // Tuya timestamps may be in seconds or milliseconds.
      return numeric < 100000000000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function detectTuyaCounterTimestampDirection(s) {
  const raw = Array.isArray(s.raw) ? s.raw : [];
  const forward = raw.find((p) => String(p?.code || "") === "total_forward_energy");
  const reverse = raw.find((p) => String(p?.code || "") === "reverse_energy_total");
  const forwardAt = tuyaPropertyTimestamp(forward);
  const reverseAt = tuyaPropertyTimestamp(reverse);
  if (!Number.isFinite(forwardAt) || !Number.isFinite(reverseAt)) return null;

  // Only use the timestamp hint when one counter is meaningfully newer.
  // Similar timestamps can mean the whole shadow snapshot refreshed together.
  const gap = Math.abs(forwardAt - reverseAt);
  if (gap < 1500) return null;
  return forwardAt > reverseAt
    ? { mode: "IMPORTING", source: "tuya-counter-update-time" }
    : { mode: "EXPORTING", source: "tuya-counter-update-time" };
}

function normalizeTuyaMeter(payload) {
  const s = payload && typeof payload === "object" ? payload : {};
  const asNullableNumber = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const importKwh = asNullableNumber(s.importKwh);
  const exportKwh = asNullableNumber(s.exportKwh);
  const powerW = Math.abs(num(s.powerW));
  const now = Date.now();
  const eps = 0.000001;
  let detected = "";
  let directionSource = "";
  let tuyaAppStatus = null;

  // Highest priority: the meter/app's own direction enum.
  // On this device: Consumption = IMPORT, Generate = EXPORT.
  const explicit = detectTuyaExplicitDirection(s);
  if (explicit) {
    detected = explicit.mode;
    directionSource = explicit.source;
    tuyaAppStatus = explicit.rawValue || null;
  }

  // Second priority: observe which cumulative energy counter actually increased.
  if (!detected && tuyaDirectionState.importKwh != null && tuyaDirectionState.exportKwh != null && importKwh != null && exportKwh != null) {
    const di = importKwh - tuyaDirectionState.importKwh;
    const de = exportKwh - tuyaDirectionState.exportKwh;
    if (di >= -eps && de >= -eps) {
      if (de > di + eps && de > eps) {
        detected = "EXPORTING";
        directionSource = "cumulative-export-counter-delta";
      } else if (di > de + eps && di > eps) {
        detected = "IMPORTING";
        directionSource = "cumulative-import-counter-delta";
      }
    }
  }

  // Third priority: Tuya shadow-property update time. This helps immediately
  // after a Master Dashboard restart, before we have two local counter samples.
  if (!detected && powerW >= 30) {
    const timestampHint = detectTuyaCounterTimestampDirection(s);
    if (timestampHint) {
      detected = timestampHint.mode;
      directionSource = timestampHint.source;
    }
  }

  if (powerW < 30) {
    detected = "IDLE";
    directionSource = "low-live-power";
  }

  // Keep a recently confirmed direction briefly when counters have not moved.
  if (!detected && powerW >= 30) {
    const recentDirection = ["IMPORTING", "EXPORTING"].includes(tuyaDirectionState.mode) && now - tuyaDirectionState.lastDirectionAt < 15 * 60 * 1000;
    if (recentDirection) {
      detected = tuyaDirectionState.mode;
      directionSource = "recent-confirmed-direction";
    }
  }

  // Do not blindly call positive/absolute Tuya power IMPORTING. The Tuya phase
  // payload is unsigned on this meter. Unknown is safer than a reversed gauge.
  if (!detected) {
    detected = powerW >= 30 ? "UNKNOWN" : "IDLE";
    directionSource = powerW >= 30 ? "awaiting-tuya-direction" : "low-live-power";
  }

  if (["IMPORTING", "EXPORTING"].includes(detected)) tuyaDirectionState.lastDirectionAt = now;
  if (importKwh != null) tuyaDirectionState.importKwh = importKwh;
  if (exportKwh != null) tuyaDirectionState.exportKwh = exportKwh;
  tuyaDirectionState.mode = detected;

  const parsedUpdated = Date.parse(String(s.updatedAt || ""));
  return {
    key: "tuya",
    name: "Tuya Physical Grid Meter",
    online: s.success !== false && s.online !== false,
    mode: detected,
    powerW,
    importW: detected === "IMPORTING" ? powerW : 0,
    exportW: detected === "EXPORTING" ? powerW : 0,
    importPctMdi: detected === "IMPORTING" ? (powerW / 5000 * 100) : 0,
    exportPctDg: detected === "EXPORTING" ? (powerW / 6000 * 100) : 0,
    voltage: asNullableNumber(s.voltage),
    currentA: asNullableNumber(s.currentA),
    powerFactor: asNullableNumber(s.powerFactor),
    temperatureC: asNullableNumber(s.temperatureC),
    importKwh,
    exportKwh,
    netKwh: asNullableNumber(s.netKwh),
    updatedAt: Number.isFinite(parsedUpdated) ? parsedUpdated : now,
    directionSource,
    tuyaAppStatus
  };
}

function combine(pv14000, pv9000, matrix) {
  const solarSystems = [pv14000, pv9000].filter(Boolean);
  const solarSum = (key) => solarSystems.reduce((total, item) => total + num(item[key]), 0);
  const utilityGridW = solarSum("gridW");
  const smartLoadW = num(pv9000?.smartLoadW);

  // Physical topology: Matrix load is downstream of PV9000 and is therefore
  // excluded by default from site demand to avoid double-counting the same watts.
  let siteDemandW = num(pv14000?.loadW) + num(pv9000?.loadW);
  if (!PV9000_LOAD_INCLUDES_SMART) siteDemandW += smartLoadW;
  if (!PV9000_LOAD_INCLUDES_UPS) siteDemandW += num(matrix?.loadW);

  const systemsPresent = [pv14000, pv9000, matrix].filter(Boolean).length;
  return {
    key: "combined",
    name: "Raja Fraz Solar Estate",
    online: systemsPresent === EXPECTED_MONITORED_SYSTEMS,
    connectedSystems: systemsPresent,
    totalSystems: EXPECTED_MONITORED_SYSTEMS,
    physicalSystems: 3,
    solarW: solarSum("solarW"),
    pvInstalledW: TOTAL_PV_INSTALLED_W,
    monitoredPvInstalledW: CURRENT_MONITORED_PV_W,
    siteUpstreamAcCapacityW: SITE_UPSTREAM_AC_CAPACITY_W,
    siteDemandW,
    utilityGridW,
    gridW: utilityGridW,
    gridDirection: direction(utilityGridW),
    smartLoadW,
    upsLoadW: num(matrix?.loadW),
    upsAcInputW: num(matrix?.acInputW),
    batteryW: num(matrix?.batteryW),
    batteryPct: matrix?.batteryPct ?? null,
    todaySolar: num(pv14000?.todaySolar) + num(pv9000?.todaySolar),
    todayLoad: num(pv14000?.todayLoad) + num(pv9000?.todayLoad) + (!PV9000_LOAD_INCLUDES_SMART ? num(pv9000?.todaySmartLoad) : 0) + (!PV9000_LOAD_INCLUDES_UPS ? num(matrix?.todayLoad) : 0),
    todayImport: num(pv14000?.todayImport) + num(pv9000?.todayImport),
    todayExport: num(pv14000?.todayExport) + num(pv9000?.todayExport),
    health: systemsPresent === EXPECTED_MONITORED_SYSTEMS ? "Excellent" : "Partial",
    topology: {
      pv9000FeedsMatrix: true,
      matrixIsUps: true,
      matrixPvInstalledW: 0,
      smartLoadSource: "pv9000",
      utilityGridSources: pv14000 ? ["pv14000", "pv9000"] : ["pv9000"],
      pv14000Telemetry: pv14000 ? "online" : "logger-pending",
      pv9000Strings: 1,
      matrixExcludedFromUtilityGrid: true,
      matrixExcludedFromSiteDemand: PV9000_LOAD_INCLUDES_UPS,
      pv9000LoadIncludesSmart: PV9000_LOAD_INCLUDES_SMART
    }
  };
}

function normalizeEnergy(payload, period = "T") {
  const source = unwrap(payload);
  return {
    period,
    solarKwh: first(source, ["todaySolar", "solarKwh", "solar"], 0),
    loadKwh: first(source, ["todayLoad", "loadKwh", "consumptionKwh", "load"], 0),
    importKwh: first(source, ["todayGrid", "todayImport", "importKwh", "gridImportKwh"], 0),
    exportKwh: first(source, ["todayNetGrid", "todayExport", "exportKwh", "gridExportKwh"], 0),
    smartLoadKwh: first(source, ["todaySmartLoad", "smartLoadKwh", "smartLoad"], 0),
    chargeKwh: first(source, ["todayCharge", "batteryChargeKwh", "chargeKwh"], 0),
    dischargeKwh: first(source, ["todayDischarge", "batteryDischargeKwh", "dischargeKwh"], 0),
    rate: first(source, ["rate", "electricityRate"], RATE)
  };
}

async function fetchEnergy(period = "T") {
  const safePeriod = ["T", "Y", "TM", "LM"].includes(period) ? period : "T";
  const tasks = [
    PV14000_API_BASE ? getPv14000Json(`/api/energy?period=${encodeURIComponent(safePeriod)}`).then((p) => normalizeEnergy(p, safePeriod)) : Promise.resolve(null),
    getPv9000Json(`/api/energy?period=${encodeURIComponent(safePeriod)}`).then((p) => normalizeEnergy(p, safePeriod)),
    getJson(`${MATRIX_API_BASE}/api/energy?period=${encodeURIComponent(safePeriod)}`).then((p) => normalizeEnergy(p, safePeriod))
  ];
  const [aResult, bResult, uResult] = await Promise.allSettled(tasks);
  const pv14000 = aResult.status === "fulfilled" ? aResult.value : null;
  const pv9000 = bResult.status === "fulfilled" ? bResult.value : null;
  const matrix = uResult.status === "fulfilled" ? uResult.value : null;

  let loadKwh = num(pv14000?.loadKwh) + num(pv9000?.loadKwh);
  if (!PV9000_LOAD_INCLUDES_SMART) loadKwh += num(pv9000?.smartLoadKwh);
  if (!PV9000_LOAD_INCLUDES_UPS) loadKwh += num(matrix?.loadKwh);

  const combined = {
    period: safePeriod,
    solarKwh: num(pv14000?.solarKwh) + num(pv9000?.solarKwh),
    loadKwh,
    importKwh: num(pv14000?.importKwh) + num(pv9000?.importKwh),
    exportKwh: num(pv14000?.exportKwh) + num(pv9000?.exportKwh),
    smartLoadKwh: num(pv9000?.smartLoadKwh),
    upsLoadKwh: num(matrix?.loadKwh),
    rate: RATE
  };
  combined.solarValuePkr = combined.solarKwh * RATE;
  combined.netGridKwh = combined.importKwh - combined.exportKwh;

  return {
    ok: Boolean(pv14000 || pv9000 || matrix),
    complete: Boolean(pv9000 && matrix && (!PV14000_API_BASE || pv14000)),
    period: safePeriod,
    pv14000,
    pv9000,
    matrix,
    combined,
    rate: RATE,
    topology: {
      matrixEnergyExcludedFromSiteTotals: PV9000_LOAD_INCLUDES_UPS,
      matrixGridExcludedFromSiteTotals: true,
      smartLoadBelongsTo: "pv9000",
      pv14000Telemetry: pv14000 ? "online" : "logger-pending",
      pv9000Strings: 1
    },
    errors: {
      ...(aResult.status === "rejected" ? { pv14000: sourceHint("PV14000", aResult.reason) } : {}),
      ...(bResult.status === "rejected" ? { pv9000: sourceHint("PV9000", bResult.reason) } : {}),
      ...(uResult.status === "rejected" ? { matrix: uResult.reason.message } : {})
    }
  };
}

function sourceHint(label, error) {
  if (!error) return null;
  if (error.code === "NOT_CONFIGURED") return `${label} API is not configured in Render.`;
  if (error.status === 401) return `${label} dashboard requires Basic Auth. Check its dashboard password in Render.`;
  return error.message;
}

// --- Render free-tier cold-start helper -----------------------------------
// When Master wakes, its upstream dashboards may still be sleeping. Wake all
// configured sources in parallel and keep retrying until their real JSON API
// responds. This removes the need to manually open every Render project.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wakeInFlight = null;
let lastWakeResult = null;
let lastWakeAt = 0;

async function wakeOneSource(label, operation, { maxWaitMs = 90000, retryMs = 4500 } = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastError = "";

  while (Date.now() - startedAt < maxWaitMs) {
    attempts += 1;
    try {
      await operation();
      return { ready: true, configured: true, attempts, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error?.message || String(error);
      // Bad credentials/configuration will not improve by waiting.
      if (error?.status === 401 || error?.status === 403 || error?.code === "NOT_CONFIGURED") break;
    }

    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(retryMs, remaining));
  }

  return { ready: false, configured: true, attempts, elapsedMs: Date.now() - startedAt, error: lastError || `${label} did not become ready` };
}

async function wakeAllSources({ force = false } = {}) {
  // If everything was confirmed ready recently, avoid unnecessary extra calls.
  if (!force && lastWakeResult && lastWakeResult.allReady && Date.now() - lastWakeAt < 10 * 60 * 1000) {
    return { ...lastWakeResult, cached: true };
  }
  if (wakeInFlight) return wakeInFlight;

  wakeInFlight = (async () => {
    const checks = [
      ["pv14000", Boolean(PV14000_API_BASE), () => getPv14000Json("/api/live?fresh=1", { timeoutMs: 14000 })],
      ["pv9000", Boolean(PV9000_API_BASE), () => getPv9000Json("/api/live?fresh=1", { timeoutMs: 14000 })],
      ["matrix", Boolean(MATRIX_API_BASE), () => getJson(`${MATRIX_API_BASE}/api/matrix`, { timeoutMs: 14000 })],
      ["tuya", Boolean(TUYA_API_BASE), () => getJson(`${TUYA_API_BASE}/api/meter`, { timeoutMs: 14000 })]
    ];

    const pairs = await Promise.all(checks.map(async ([key, configured, operation]) => {
      if (!configured) return [key, { ready: false, configured: false, skipped: true, attempts: 0, elapsedMs: 0 }];
      return [key, await wakeOneSource(key, operation)];
    }));

    const sources = Object.fromEntries(pairs);
    const configuredEntries = Object.values(sources).filter((x) => x.configured);
    const readyCount = configuredEntries.filter((x) => x.ready).length;
    const result = {
      ok: readyCount > 0,
      allReady: configuredEntries.length > 0 && readyCount === configuredEntries.length,
      readyCount,
      totalConfigured: configuredEntries.length,
      sources,
      updatedAt: Date.now(),
      note: "Cold-start wake only; no always-on keepalive is used."
    };
    lastWakeAt = Date.now();
    lastWakeResult = result;
    return result;
  })().finally(() => { wakeInFlight = null; });

  return wakeInFlight;
}

async function initDb() {
  if (!pool) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS master_samples_v3 (
        id BIGSERIAL PRIMARY KEY,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pv14000_online BOOLEAN NOT NULL DEFAULT FALSE,
        pv9000_online BOOLEAN NOT NULL DEFAULT FALSE,
        matrix_online BOOLEAN NOT NULL DEFAULT FALSE,
        pv14000_solar_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv14000_load_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv14000_grid_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv14000_pv1_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv14000_pv2_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv14000_temp_c DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_solar_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_load_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_grid_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_pv1_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_pv2_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_smart_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        pv9000_temp_c DOUBLE PRECISION NOT NULL DEFAULT 0,
        matrix_ac_input_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        matrix_load_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        matrix_battery_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        matrix_battery_pct DOUBLE PRECISION,
        matrix_temp_c DOUBLE PRECISION NOT NULL DEFAULT 0,
        combined_solar_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        combined_demand_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        combined_grid_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        combined_smart_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        combined_ups_load_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        meter_online BOOLEAN NOT NULL DEFAULT FALSE,
        meter_mode TEXT NOT NULL DEFAULT 'IDLE',
        meter_power_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        meter_import_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        meter_export_w DOUBLE PRECISION NOT NULL DEFAULT 0,
        meter_voltage_v DOUBLE PRECISION,
        meter_current_a DOUBLE PRECISION,
        meter_pf DOUBLE PRECISION,
        meter_temp_c DOUBLE PRECISION
      );
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_online BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_mode TEXT NOT NULL DEFAULT 'IDLE';
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_power_w DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_import_w DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_export_w DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_voltage_v DOUBLE PRECISION;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_current_a DOUBLE PRECISION;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_pf DOUBLE PRECISION;
      ALTER TABLE master_samples_v3 ADD COLUMN IF NOT EXISTS meter_temp_c DOUBLE PRECISION;
      CREATE INDEX IF NOT EXISTS master_samples_v3_captured_at_idx ON master_samples_v3 (captured_at DESC);
      CREATE TABLE IF NOT EXISTS master_push_subscriptions_v1 (
        endpoint TEXT PRIMARY KEY,
        subscription JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_notification_events_v1 (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        alert_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        channels JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_recovery BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS master_notification_events_v1_created_at_idx ON master_notification_events_v1 (created_at DESC);
    `);
    dbReady = true;
    return true;
  } catch (error) {
    console.error("Postgres init failed:", error.message);
    dbReady = false;
    return false;
  }
}

async function storeSample(live, force = false) {
  if (!pool || !dbReady || !live?.systems) return false;
  const now = Date.now();
  if (!force && now - lastStoredAt < HISTORY_SAMPLE_SECONDS * 1000 * 0.9) return false;
  const a = live.systems.pv14000 || {};
  const b = live.systems.pv9000 || {};
  const u = live.systems.matrix || {};
  const c = live.systems.combined || {};
  const m = live.meter || {};
  try {
    await pool.query(`
      INSERT INTO master_samples_v3 (
        captured_at, pv14000_online, pv9000_online, matrix_online,
        pv14000_solar_w, pv14000_load_w, pv14000_grid_w, pv14000_pv1_w, pv14000_pv2_w, pv14000_temp_c,
        pv9000_solar_w, pv9000_load_w, pv9000_grid_w, pv9000_pv1_w, pv9000_pv2_w, pv9000_smart_w, pv9000_temp_c,
        matrix_ac_input_w, matrix_load_w, matrix_battery_w, matrix_battery_pct, matrix_temp_c,
        combined_solar_w, combined_demand_w, combined_grid_w, combined_smart_w, combined_ups_load_w,
        meter_online, meter_mode, meter_power_w, meter_import_w, meter_export_w, meter_voltage_v, meter_current_a, meter_pf, meter_temp_c
      ) VALUES (
        NOW(), $1, $2, $3,
        $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31, $32, $33, $34, $35
      )
    `, [
      Boolean(live.systems.pv14000), Boolean(live.systems.pv9000), Boolean(live.systems.matrix),
      num(a.solarW), num(a.loadW), num(a.gridW), num(a.pv1W), num(a.pv2W), num(a.temp),
      num(b.solarW), num(b.loadW), num(b.gridW), num(b.pv1W), num(b.pv2W), num(b.smartLoadW), num(b.temp),
      num(u.acInputW), num(u.loadW), num(u.batteryW), u.batteryPct == null ? null : num(u.batteryPct), num(u.transformer || u.temp),
      num(c.solarW), num(c.siteDemandW), num(c.gridW), num(c.smartLoadW), num(c.upsLoadW),
      Boolean(m.online), String(m.mode || "IDLE"), num(m.powerW), num(m.importW), num(m.exportW),
      m.voltage == null ? null : num(m.voltage), m.currentA == null ? null : num(m.currentA),
      m.powerFactor == null ? null : num(m.powerFactor), m.temperatureC == null ? null : num(m.temperatureC)
    ]);
    lastStoredAt = now;
    return true;
  } catch (error) {
    console.error("History insert failed:", error.message);
    return false;
  }
}

async function fetchLive({ store = true, cacheMs = 4500 } = {}) {
  if (lastLiveCache && Date.now() - lastLiveCacheAt < cacheMs) {
    if (store) storeSample(lastLiveCache).catch(() => {});
    return lastLiveCache;
  }
  const systems = {};
  const errors = {};
  const [aResult, bResult, uResult, tResult] = await Promise.allSettled([
    PV14000_API_BASE ? getPv14000Json("/api/live?fresh=1").then(normalizePv14000) : Promise.resolve(null),
    getPv9000Json("/api/live?fresh=1").then(normalizePv9000),
    getJson(`${MATRIX_API_BASE}/api/matrix`).then(normalizeMatrixUps),
    getJson(`${TUYA_API_BASE}/api/meter`).then(normalizeTuyaMeter)
  ]);

  if (aResult.status === "fulfilled" && aResult.value) systems.pv14000 = aResult.value;
  else if (PV14000_API_BASE && aResult.status === "rejected") errors.pv14000 = sourceHint("PV14000", aResult.reason);
  if (bResult.status === "fulfilled") systems.pv9000 = bResult.value;
  else errors.pv9000 = sourceHint("PV9000", bResult.reason);
  if (uResult.status === "fulfilled") systems.matrix = uResult.value;
  else errors.matrix = uResult.reason.message;
  let meter = null;
  if (tResult.status === "fulfilled") meter = tResult.value;
  else errors.tuya = tResult.reason.message;

  systems.combined = combine(systems.pv14000, systems.pv9000, systems.matrix);
  const connected = [systems.pv14000, systems.pv9000, systems.matrix].filter(Boolean).length;
  const result = {
    ok: connected > 0,
    complete: connected === EXPECTED_MONITORED_SYSTEMS,
    connected,
    totalSystems: EXPECTED_MONITORED_SYSTEMS,
    physicalSystems: 3,
    systems,
    meter,
    errors,
    updatedAt: Date.now(),
    refreshSeconds: 10,
    matrixFrameSeconds: 60,
    tuyaPollSeconds: 10,
    rate: RATE,
    capacities: {
      pv14000PvW: PV14000_PV_INSTALLED_W,
      pv14000AcW: PV14000_AC_CAPACITY_W,
      pv9000PvW: PV9000_PV_INSTALLED_W,
      pv9000AcW: PV9000_AC_CAPACITY_W,
      matrixPvW: 0,
      matrixAcW: MATRIX_AC_CAPACITY_W,
      totalPvW: TOTAL_PV_INSTALLED_W,
      monitoredPvW: CURRENT_MONITORED_PV_W,
      batteryKwh: BATTERY_CAPACITY_KWH || null
    },
    guardrails: {
      nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W,
      dayModeStart: DAY_MODE_START, dayModeEnd: DAY_MODE_END, exportRatePkr: EXPORT_RATE,
      targetDailyYieldKwhPerKwp: TARGET_DAILY_YIELD_KWH_PER_KWP || null,
      reconciliationAlertW: RECONCILIATION_ALERT_W, alertTempC: ALERT_TEMP_C
    },
    topology: systems.combined.topology,
    telemetryPlan: {
      pv14000: PV14000_API_BASE ? "configured" : "waiting-for-new-wifi-logger",
      pv9000: "reassigned-wifi-logger",
      pv9000Strings: 1,
      pv9000Panels: 8,
      pv9000PanelWatts: 545
    },
    history: {
      online: Boolean(pool && dbReady),
      storage: pool && dbReady ? "PostgreSQL" : "source/fallback",
      sampleSeconds: HISTORY_SAMPLE_SECONDS
    }
  };
  lastLiveCache = result;
  lastLiveCacheAt = Date.now();
  if (store) await storeSample(result);
  return result;
}

function normalizeHistory(payload, role = "solar") {
  const source = payload?.data || unwrap(payload)?.data || [];
  if (!Array.isArray(source)) return [];
  return source.map((p) => {
    const base = {
      timestamp: num(p.timestamp || p.receivedAt || Date.now()),
      loadW: num(p.loadW || p.loadWatts),
      tempC: num(p.tempC || p.temperature || p.transformer)
    };
    if (role === "ups") {
      return {
        ...base,
        solarW: 0,
        acInputW: Math.abs(num(p.acInputW ?? p.gridW ?? p.gridWatts)),
        batteryW: num(p.batteryW || p.batteryPowerWatts),
        batteryPct: p.batteryPct == null ? null : num(p.batteryPct)
      };
    }
    return {
      ...base,
      solarW: num(p.solarW || p.solarWatts),
      gridW: num(p.gridW || p.gridWatts),
      pv1W: num(p.pv1W || p.pv1Watts),
      pv2W: num(p.pv2W || p.pv2Watts),
      smartLoadW: num(p.smartLoadW || p.smartLoadWatts)
    };
  });
}

async function dbHistory(hours) {
  if (!pool || !dbReady) return null;
  const maxRows = hours <= 24 ? 3000 : hours <= 168 ? 12000 : 24000;
  try {
    const { rows } = await pool.query(`
      SELECT * FROM master_samples_v3
      WHERE captured_at >= NOW() - ($1::text || ' hours')::interval
      ORDER BY captured_at ASC
      LIMIT $2
    `, [String(hours), maxRows]);

    const pv14000 = rows.map((r) => ({
      timestamp: new Date(r.captured_at).getTime(),
      solarW: num(r.pv14000_solar_w), loadW: num(r.pv14000_load_w), gridW: num(r.pv14000_grid_w),
      pv1W: num(r.pv14000_pv1_w), pv2W: num(r.pv14000_pv2_w), smartLoadW: 0, tempC: num(r.pv14000_temp_c)
    }));
    const pv9000 = rows.map((r) => ({
      timestamp: new Date(r.captured_at).getTime(),
      solarW: num(r.pv9000_solar_w), loadW: num(r.pv9000_load_w), gridW: num(r.pv9000_grid_w),
      pv1W: num(r.pv9000_pv1_w), pv2W: num(r.pv9000_pv2_w), smartLoadW: num(r.pv9000_smart_w), tempC: num(r.pv9000_temp_c)
    }));
    const matrix = rows.map((r) => ({
      timestamp: new Date(r.captured_at).getTime(),
      solarW: 0, loadW: num(r.matrix_load_w), acInputW: num(r.matrix_ac_input_w),
      batteryW: num(r.matrix_battery_w), batteryPct: r.matrix_battery_pct == null ? null : num(r.matrix_battery_pct),
      tempC: num(r.matrix_temp_c)
    }));
    const combined = rows.map((r) => ({
      timestamp: new Date(r.captured_at).getTime(),
      solarW: num(r.combined_solar_w), loadW: num(r.combined_demand_w), gridW: num(r.combined_grid_w),
      smartLoadW: num(r.combined_smart_w), upsLoadW: num(r.combined_ups_load_w),
      meterOnline: Boolean(r.meter_online), meterMode: String(r.meter_mode || "IDLE"), meterPowerW: num(r.meter_power_w),
      meterImportW: num(r.meter_import_w), meterExportW: num(r.meter_export_w),
      meterVoltageV: r.meter_voltage_v == null ? null : num(r.meter_voltage_v),
      meterCurrentA: r.meter_current_a == null ? null : num(r.meter_current_a),
      meterPf: r.meter_pf == null ? null : num(r.meter_pf), meterTempC: r.meter_temp_c == null ? null : num(r.meter_temp_c),
      batteryW: num(r.matrix_battery_w), batteryPct: r.matrix_battery_pct == null ? null : num(r.matrix_battery_pct)
    }));
    return { ok: true, pv14000, pv9000, matrix, combined, storage: "postgres", samples: rows.length, sampleSeconds: HISTORY_SAMPLE_SECONDS };
  } catch (error) {
    console.error("History query failed:", error.message);
    return null;
  }
}

async function fetchHistory(hours = 24) {
  const stored = await dbHistory(hours);
  if (stored) return stored;
  const [aResult, bResult, uResult] = await Promise.allSettled([
    PV14000_API_BASE ? getPv14000Json(`/api/history?hours=${hours}`) : Promise.resolve(null),
    getPv9000Json(`/api/history?hours=${hours}`),
    getJson(`${MATRIX_API_BASE}/api/history?hours=${hours}`)
  ]);
  return {
    ok: true,
    pv14000: aResult.status === "fulfilled" && aResult.value ? normalizeHistory(aResult.value, "solar") : [],
    pv9000: bResult.status === "fulfilled" ? normalizeHistory(bResult.value, "solar") : [],
    matrix: uResult.status === "fulfilled" ? normalizeHistory(uResult.value, "ups") : [],
    combined: [],
    storage: "source-fallback",
    samples: 0,
    errors: {
      ...(aResult.status === "rejected" ? { pv14000: sourceHint("PV14000", aResult.reason) } : {}),
      ...(bResult.status === "rejected" ? { pv9000: sourceHint("PV9000", bResult.reason) } : {}),
      ...(uResult.status === "rejected" ? { matrix: uResult.reason.message } : {})
    }
  };
}

async function historyStats() {
  if (!pool || !dbReady) return { online: false, storage: "fallback", samples: 0 };
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS count, MIN(captured_at) AS first_at, MAX(captured_at) AS last_at FROM master_samples_v3`);
    const r = rows[0] || {};
    return { online: true, storage: "PostgreSQL", samples: Number(r.count || 0), firstAt: r.first_at, lastAt: r.last_at, sampleSeconds: HISTORY_SAMPLE_SECONDS };
  } catch (error) {
    return { online: false, storage: "PostgreSQL error", samples: 0, error: error.message };
  }
}


async function fetchTuyaEnergyStats() {
  return getJson(`${TUYA_API_BASE}/api/energy-stats`, { timeoutMs: 20000 });
}

async function fetchTuyaEnergyRange(params) {
  const type = String(params.type || "day").toLowerCase();
  const qs = new URLSearchParams({ type });
  if (type === "day") {
    const date = String(params.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid Tuya day selection");
    qs.set("date", date);
  } else if (type === "month") {
    const month = String(params.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid Tuya month selection");
    qs.set("month", month);
  } else {
    throw new Error("Tuya range type must be day or month");
  }
  return getJson(`${TUYA_API_BASE}/api/energy-range?${qs.toString()}`, { timeoutMs: type === "month" ? 30000 : 20000 });
}

async function analyticsFromDb() {
  const empty = {
    online: false, todaySamples: 0,
    todayImportPeakW: 0, todayExportPeakW: 0, monthImportPeakW: 0, monthExportPeakW: 0,
    todayImportPeakAt: null, todayExportPeakAt: null, monthImportPeakAt: null, monthExportPeakAt: null,
    todaySolarPeakW: 0, todaySolarPeakAt: null, solarStartAt: null, solarEndAt: null,
    todayDemandPeakW: 0, todayDemandPeakAt: null,
    bestDay: null, worstDay: null
  };
  if (!pool || !dbReady) return empty;
  try {
    const { rows } = await pool.query(`
      WITH local_rows AS (
        SELECT *, captured_at AT TIME ZONE 'Asia/Karachi' AS local_ts
        FROM master_samples_v3
        WHERE captured_at >= NOW() - INTERVAL '40 days'
      ),
      today AS (
        SELECT * FROM local_rows
        WHERE local_ts::date = (NOW() AT TIME ZONE 'Asia/Karachi')::date
      ),
      month_rows AS (
        SELECT * FROM local_rows
        WHERE date_trunc('month', local_ts) = date_trunc('month', NOW() AT TIME ZONE 'Asia/Karachi')
      ),
      daily AS (
        SELECT local_ts::date AS day,
               SUM(combined_solar_w) * $1::double precision / 3600000.0 AS solar_kwh_est
        FROM local_rows
        WHERE local_ts::date < (NOW() AT TIME ZONE 'Asia/Karachi')::date
        GROUP BY local_ts::date
        HAVING COUNT(*) >= 10
      )
      SELECT
        (SELECT COUNT(*) FROM today)::bigint AS today_samples,
        COALESCE((SELECT MAX(meter_import_w) FROM today),0) AS today_import_peak_w,
        COALESCE((SELECT MAX(meter_export_w) FROM today),0) AS today_export_peak_w,
        COALESCE((SELECT MAX(meter_import_w) FROM month_rows),0) AS month_import_peak_w,
        COALESCE((SELECT MAX(meter_export_w) FROM month_rows),0) AS month_export_peak_w,
        (SELECT captured_at FROM today ORDER BY meter_import_w DESC NULLS LAST LIMIT 1) AS today_import_peak_at,
        (SELECT captured_at FROM today ORDER BY meter_export_w DESC NULLS LAST LIMIT 1) AS today_export_peak_at,
        (SELECT captured_at FROM month_rows ORDER BY meter_import_w DESC NULLS LAST LIMIT 1) AS month_import_peak_at,
        (SELECT captured_at FROM month_rows ORDER BY meter_export_w DESC NULLS LAST LIMIT 1) AS month_export_peak_at,
        COALESCE((SELECT MAX(combined_solar_w) FROM today),0) AS today_solar_peak_w,
        (SELECT captured_at FROM today ORDER BY combined_solar_w DESC NULLS LAST LIMIT 1) AS today_solar_peak_at,
        (SELECT MIN(captured_at) FROM today WHERE combined_solar_w >= 100) AS solar_start_at,
        (SELECT MAX(captured_at) FROM today WHERE combined_solar_w >= 100) AS solar_end_at,
        COALESCE((SELECT MAX(combined_demand_w) FROM today),0) AS today_demand_peak_w,
        (SELECT captured_at FROM today ORDER BY combined_demand_w DESC NULLS LAST LIMIT 1) AS today_demand_peak_at,
        (SELECT json_build_object('date',day,'solarKwh',solar_kwh_est) FROM daily ORDER BY solar_kwh_est DESC LIMIT 1) AS best_day,
        (SELECT json_build_object('date',day,'solarKwh',solar_kwh_est) FROM daily ORDER BY solar_kwh_est ASC LIMIT 1) AS worst_day
    `, [HISTORY_SAMPLE_SECONDS]);
    const r = rows[0] || {};
    return {
      online: true,
      todaySamples: Number(r.today_samples || 0),
      todayImportPeakW: num(r.today_import_peak_w), todayExportPeakW: num(r.today_export_peak_w),
      monthImportPeakW: num(r.month_import_peak_w), monthExportPeakW: num(r.month_export_peak_w),
      todayImportPeakAt: r.today_import_peak_at || null, todayExportPeakAt: r.today_export_peak_at || null,
      monthImportPeakAt: r.month_import_peak_at || null, monthExportPeakAt: r.month_export_peak_at || null,
      todaySolarPeakW: num(r.today_solar_peak_w), todaySolarPeakAt: r.today_solar_peak_at || null,
      solarStartAt: r.solar_start_at || null, solarEndAt: r.solar_end_at || null,
      todayDemandPeakW: num(r.today_demand_peak_w), todayDemandPeakAt: r.today_demand_peak_at || null,
      bestDay: r.best_day || null, worstDay: r.worst_day || null,
      note: "Daily energy ranking is estimated from stored power samples."
    };
  } catch (error) {
    return { ...empty, error: error.message };
  }
}

async function fetchAnalytics() {
  const live = await fetchLive({ store: false, cacheMs: 4500 });
  const stats = await analyticsFromDb();
  const a = live.systems?.pv14000 || null;
  const b = live.systems?.pv9000 || null;
  const u = live.systems?.matrix || null;
  const c = live.systems?.combined || {};
  const m = live.meter || null;
  const clock = pakistanClock();
  const physicalSignedW = m?.online && m.mode === "IMPORTING" ? num(m.importW)
    : m?.online && m.mode === "EXPORTING" ? -num(m.exportW)
    : m?.online && m.mode === "IDLE" ? 0 : null;
  const inverterSignedW = num(c.gridW);
  const reconciliationDiffW = physicalSignedW == null ? null : physicalSignedW - inverterSignedW;
  const reconciliationAbsW = reconciliationDiffW == null ? null : Math.abs(reconciliationDiffW);
  const reconciliationBaseW = physicalSignedW == null ? 0 : Math.max(100, Math.abs(physicalSignedW), Math.abs(inverterSignedW));
  const reconciliationPct = reconciliationAbsW == null ? null : reconciliationAbsW / reconciliationBaseW * 100;
  const importW = num(m?.importW);
  const exportW = num(m?.exportW);
  const activeLimitW = clock.dayMode ? DAY_EXPORT_LIMIT_W : NIGHT_IMPORT_LIMIT_W;
  const activePowerW = clock.dayMode ? exportW : importW;
  const headroomW = activeLimitW - activePowerW;
  const soc = u?.batteryPct == null ? null : num(u.batteryPct);
  const upsLoadW = num(u?.loadW);
  const remainingBatteryKwh = BATTERY_CAPACITY_KWH > 0 && soc != null ? BATTERY_CAPACITY_KWH * Math.max(0, Math.min(100, soc)) / 100 : null;
  const backupRuntimeHours = remainingBatteryKwh != null && upsLoadW >= 50 ? remainingBatteryKwh / (upsLoadW / 1000) : null;
  const balanceUsingPhysicalW = physicalSignedW == null ? null : num(c.solarW) + physicalSignedW - num(c.siteDemandW);
  const solarCapacityPct = CURRENT_MONITORED_PV_W > 0 ? num(c.solarW) / CURRENT_MONITORED_PV_W * 100 : 0;
  return {
    ok: Boolean(live.ok), updatedAt: Date.now(), timezone: "Asia/Karachi",
    mode: { dayMode: clock.dayMode, label: clock.label, dayStart: DAY_MODE_START, dayEnd: DAY_MODE_END },
    config: {
      nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W,
      electricityRatePkr: RATE, exportRatePkr: EXPORT_RATE,
      batteryCapacityKwh: BATTERY_CAPACITY_KWH || null,
      targetDailyYieldKwhPerKwp: TARGET_DAILY_YIELD_KWH_PER_KWP || null,
      reconciliationAlertW: RECONCILIATION_ALERT_W, alertTempC: ALERT_TEMP_C,
      physicalPvInstalledW: TOTAL_PV_INSTALLED_W, monitoredPvInstalledW: CURRENT_MONITORED_PV_W
    },
    current: {
      solarW: num(c.solarW), demandW: num(c.siteDemandW), inverterGridW: inverterSignedW,
      physicalGridW: physicalSignedW, importW, exportW,
      activeLimitW, activePowerW, headroomW,
      balanceErrorW: balanceUsingPhysicalW,
      reconciliationDiffW, reconciliationAbsW, reconciliationPct,
      batteryPct: soc, batteryW: num(u?.batteryW), upsLoadW,
      backupRuntimeHours, remainingBatteryKwh,
      solarCapacityPct,
      pv14000SolarW: num(a?.solarW), pv9000SolarW: num(b?.solarW)
    },
    peaks: stats,
    safety: { readOnly: true, note: "Monitoring and analytics only. No Tuya or inverter control command is sent by Master." }
  };
}

async function fetchWeather() {
  try {
    const payload = await getJson(`${MATRIX_API_BASE}/api/weather`, { timeoutMs: 8000 });
    return { ok: true, data: unwrap(payload) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}


function notificationPinAccepted(req) {
  if (!NOTIFY_ACCESS_PIN) return true;
  const supplied = String(req.headers["x-notify-pin"] || req.headers["x-ai-pin"] || "").trim();
  return supplied === NOTIFY_ACCESS_PIN;
}
function normalizeWhatsAppAddress(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return v.startsWith("whatsapp:") ? v : `whatsapp:${v}`;
}
function notificationChannelFlags() {
  return {
    webPush: webPushConfigured,
    telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    whatsapp: Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM && TWILIO_WHATSAPP_TO),
    sms: Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_SMS_FROM && TWILIO_SMS_TO)
  };
}
async function countPushSubscriptions() {
  if (pool && dbReady) {
    try {
      const r = await pool.query("SELECT COUNT(*)::int AS count FROM master_push_subscriptions_v1");
      return Number(r.rows?.[0]?.count || 0);
    } catch {}
  }
  return pushSubscriptionsMemory.size;
}
async function getPushSubscriptions() {
  if (pool && dbReady) {
    try {
      const r = await pool.query("SELECT endpoint, subscription FROM master_push_subscriptions_v1 ORDER BY updated_at DESC");
      return r.rows.map((row) => row.subscription).filter(Boolean);
    } catch (error) {
      console.error("Push subscription read:", error.message);
    }
  }
  return [...pushSubscriptionsMemory.values()];
}
async function savePushSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || "").trim();
  const p256dh = String(subscription?.keys?.p256dh || "").trim();
  const auth = String(subscription?.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) {
    const error = new Error("Invalid Web Push subscription");
    error.status = 400;
    throw error;
  }
  const clean = { endpoint, expirationTime: subscription.expirationTime ?? null, keys: { p256dh, auth } };
  pushSubscriptionsMemory.set(endpoint, clean);
  alertDeliveryState.clear();
  if (pool && dbReady) {
    await pool.query(`
      INSERT INTO master_push_subscriptions_v1 (endpoint, subscription, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (endpoint) DO UPDATE SET subscription = EXCLUDED.subscription, updated_at = NOW()
    `, [endpoint, JSON.stringify(clean)]);
  }
  return clean;
}
async function deletePushSubscription(endpoint) {
  const key = String(endpoint || "").trim();
  if (!key) return false;
  pushSubscriptionsMemory.delete(key);
  if (pool && dbReady) {
    try { await pool.query("DELETE FROM master_push_subscriptions_v1 WHERE endpoint = $1", [key]); } catch {}
  }
  return true;
}
async function notificationStatus() {
  const flags = notificationChannelFlags();
  return {
    ok: true,
    pinRequired: Boolean(NOTIFY_ACCESS_PIN),
    channels: {
      webPush: { configured: flags.webPush, subscriptions: await countPushSubscriptions(), publicKey: flags.webPush ? VAPID_PUBLIC_KEY : null },
      telegram: { configured: flags.telegram },
      whatsapp: { configured: flags.whatsapp, templateConfigured: Boolean(TWILIO_WHATSAPP_CONTENT_SID) },
      sms: { configured: flags.sms }
    },
    policy: {
      cooldownMinutes: ALERT_COOLDOWN_MINUTES,
      staleSeconds: ALERT_STALE_SECONDS,
      batteryLowPct: BATTERY_LOW_PCT,
      nightImportLimitW: NIGHT_IMPORT_LIMIT_W,
      dayExportLimitW: DAY_EXPORT_LIMIT_W,
      temperatureLimitC: ALERT_TEMP_C,
      reconciliationAlertW: RECONCILIATION_ALERT_W
    },
    note: "Alerts are monitoring-only. Notification delivery never sends a Tuya or inverter control command."
  };
}
function alertIcon(severity, recovery = false) {
  if (recovery) return "✅";
  if (severity === "critical") return "🚨";
  if (severity === "warning") return "⚠️";
  return "ℹ️";
}
function formatNotificationText(alert) {
  const icon = alertIcon(alert.severity, alert.isRecovery);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const lines = [
    `${icon} RAJA FRAZ SOLAR`,
    String(alert.title || "Solar alert"),
    String(alert.message || "").trim(),
    alert.action ? `Action: ${alert.action}` : "",
    `PKT ${clock}`
  ].filter(Boolean);
  return lines.join("\n").slice(0, 1400);
}
async function sendTelegramAlert(alert) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { channel: "telegram", skipped: true, reason: "not configured" };
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: formatNotificationText(alert), disable_web_page_preview: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.description || `Telegram HTTP ${response.status}`);
  return { channel: "telegram", ok: true, messageId: data?.result?.message_id || null };
}
async function sendTwilioForm(params) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`, "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || `Twilio HTTP ${response.status}`);
  return data;
}
async function sendSmsAlert(alert) {
  if (!notificationChannelFlags().sms) return { channel: "sms", skipped: true, reason: "not configured" };
  const data = await sendTwilioForm({ To: TWILIO_SMS_TO, From: TWILIO_SMS_FROM, Body: formatNotificationText(alert) });
  return { channel: "sms", ok: true, sid: data?.sid || null };
}
async function sendWhatsAppAlert(alert) {
  if (!notificationChannelFlags().whatsapp) return { channel: "whatsapp", skipped: true, reason: "not configured" };
  const params = { To: normalizeWhatsAppAddress(TWILIO_WHATSAPP_TO), From: normalizeWhatsAppAddress(TWILIO_WHATSAPP_FROM) };
  if (TWILIO_WHATSAPP_CONTENT_SID) {
    params.ContentSid = TWILIO_WHATSAPP_CONTENT_SID;
    params.ContentVariables = JSON.stringify({ "1": formatNotificationText(alert) });
  } else {
    params.Body = formatNotificationText(alert);
  }
  const data = await sendTwilioForm(params);
  return { channel: "whatsapp", ok: true, sid: data?.sid || null };
}
async function sendWebPushAlert(alert) {
  if (!webPushConfigured) return { channel: "webPush", skipped: true, reason: "VAPID not configured" };
  const subscriptions = await getPushSubscriptions();
  if (!subscriptions.length) return { channel: "webPush", skipped: true, reason: "no subscribed browsers" };
  const payload = JSON.stringify({
    title: `${alertIcon(alert.severity, alert.isRecovery)} ${alert.title || "Raja Fraz Solar"}`,
    body: String(alert.message || "Solar alert"),
    action: alert.action || "",
    severity: alert.severity || "info",
    tag: `raja-fraz-${alert.key || "solar"}`,
    url: NOTIFY_DASHBOARD_URL
  });
  let sent = 0;
  const failed = [];
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: alert.severity === "critical" ? "high" : "normal", topic: String(alert.key || "solar").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "solar" });
      sent += 1;
    } catch (error) {
      failed.push({ endpoint: subscription.endpoint, statusCode: error?.statusCode || null, message: error?.message || String(error) });
      if (error?.statusCode === 404 || error?.statusCode === 410) await deletePushSubscription(subscription.endpoint);
    }
  }
  return { channel: "webPush", ok: sent > 0, sent, failed: failed.length };
}
async function logNotificationEvent(alert, results) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(`
      INSERT INTO master_notification_events_v1 (alert_key, severity, title, message, channels, is_recovery)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
    `, [String(alert.key || "alert"), String(alert.severity || "info"), String(alert.title || "Solar alert"), String(alert.message || ""), JSON.stringify(results || []), Boolean(alert.isRecovery)]);
  } catch (error) {
    console.error("Notification history insert:", error.message);
  }
}
async function dispatchNotifications(alert, { channels = null } = {}) {
  const requested = Array.isArray(channels) && channels.length ? new Set(channels) : null;
  const jobs = [];
  const add = (name, fn) => { if (!requested || requested.has(name)) jobs.push(fn().catch((error) => ({ channel: name, ok: false, error: error.message }))); };
  add("webPush", () => sendWebPushAlert(alert));
  add("telegram", () => sendTelegramAlert(alert));
  add("whatsapp", () => sendWhatsAppAlert(alert));
  add("sms", () => sendSmsAlert(alert));
  const results = await Promise.all(jobs);
  await logNotificationEvent(alert, results);
  return results;
}
function buildLiveAlerts(live) {
  const alerts = [];
  const add = (key, severity, title, message, action = "") => alerts.push({ key, severity, title, message, action });
  const s = live?.systems || {};
  const a = s.pv14000 || null, b = s.pv9000 || null, u = s.matrix || null, c = s.combined || {};
  const m = live?.meter || null;
  if (PV14000_API_BASE && !a) add("pv14000-offline", "critical", "PV14000 OFFLINE", "Fronus Meta 10 kW telemetry is unavailable.", "Check the new inverter Wi-Fi/API path.");
  if (PV9000_API_BASE && !b) add("pv9000-offline", "warning", "PV9000 OFFLINE", "Fronus Meta 6 kW telemetry is unavailable.", "Check inverter Wi-Fi and PV9000 API service.");
  if (!u) add("matrix-offline", "critical", "MATRIX UPS OFFLINE", "Matrix UPS telemetry is unavailable.", "Check UPS communication before maintenance decisions.");
  if (!m?.online) add("tuya-offline", "critical", "TUYA GRID METER OFFLINE", "Physical utility meter data is unavailable, so grid guardrails cannot be trusted.", "Check Tuya cloud/device connectivity.");

  const clock = pakistanClock();
  if (m?.online) {
    const mode = String(m.mode || "").toUpperCase();
    const importW = num(m.importW), exportW = num(m.exportW);
    if (!clock.dayMode && mode === "IMPORTING") {
      const pct = importW / NIGHT_IMPORT_LIMIT_W * 100;
      if (pct >= 100) add("night-import-over", "critical", "NIGHT IMPORT LIMIT EXCEEDED", `${Math.round(importW)} W import is above the ${Math.round(NIGHT_IMPORT_LIMIT_W)} W target.`, "Reduce non-essential load and inspect the active load mix.");
      else if (pct >= 90) add("night-import-watch", "warning", "NIGHT IMPORT NEAR LIMIT", `${Math.round(importW)} W import is ${pct.toFixed(0)}% of the ${Math.round(NIGHT_IMPORT_LIMIT_W)} W target.`, "Avoid adding large loads.");
    }
    if (clock.dayMode && mode === "EXPORTING") {
      const pct = exportW / DAY_EXPORT_LIMIT_W * 100;
      if (pct >= 100) add("day-export-over", "critical", "DAY EXPORT LIMIT EXCEEDED", `${Math.round(exportW)} W export is above the ${Math.round(DAY_EXPORT_LIMIT_W)} W target.`, "Review export control / generation immediately.");
      else if (pct >= 90) add("day-export-watch", "warning", "DAY EXPORT NEAR LIMIT", `${Math.round(exportW)} W export is ${pct.toFixed(0)}% of the ${Math.round(DAY_EXPORT_LIMIT_W)} W target.`, "Watch generation and site load headroom.");
    }
    if (mode === "UNKNOWN" && num(m.powerW) > 500) add("tuya-direction-unknown", "warning", "GRID DIRECTION UNKNOWN", `Tuya reports ${Math.round(num(m.powerW))} W but import/export direction is not confirmed.`, "Wait for counter-delta confirmation before acting on direction.");
  }

  if (u?.batteryPct != null && num(u.batteryPct) < BATTERY_LOW_PCT) {
    add("battery-low", num(u.batteryPct) < 10 ? "critical" : "warning", "UPS BATTERY LOW", `Matrix battery SOC is ${Math.round(num(u.batteryPct))}%.`, "Reduce backup load or restore charging source.");
  }
  const tempSources = [["pv14000", "PV14000", a?.temp], ["pv9000", "PV9000", b?.temp], ["matrix", "Matrix UPS", u?.transformer ?? u?.temp], ["tuya", "Tuya meter", m?.temperatureC]];
  for (const [key, label, value] of tempSources) {
    if (value != null && num(value) > ALERT_TEMP_C) add(`${key}-high-temp`, "warning", `${label.toUpperCase()} HIGH TEMPERATURE`, `${Math.round(num(value))}°C is above the ${Math.round(ALERT_TEMP_C)}°C alert level.`, "Inspect ventilation, fans and load.");
  }
  const staleMs = ALERT_STALE_SECONDS * 1000;
  for (const [key, label, obj] of [["pv14000", "PV14000", a], ["pv9000", "PV9000", b], ["matrix", "Matrix UPS", u], ["tuya", "Tuya meter", m]]) {
    if (obj?.updatedAt && Date.now() - num(obj.updatedAt) > staleMs) add(`${key}-stale`, "warning", `${label.toUpperCase()} DATA STALE`, `Latest telemetry is older than ${ALERT_STALE_SECONDS} seconds.`, "Check cloud/API connectivity before trusting live values.");
  }
  if (m?.online && ["IMPORTING", "EXPORTING", "IDLE"].includes(String(m.mode || "").toUpperCase())) {
    const physicalSigned = String(m.mode || "").toUpperCase() === "IMPORTING" ? num(m.importW) : String(m.mode || "").toUpperCase() === "EXPORTING" ? -num(m.exportW) : 0;
    const inverterSigned = num(c.utilityGridW ?? c.gridW);
    const diff = Math.abs(physicalSigned - inverterSigned);
    if (diff > RECONCILIATION_ALERT_W * 2) add("grid-reconciliation-critical", "critical", "GRID METER MISMATCH", `Tuya and inverter grid readings differ by about ${Math.round(diff)} W.`, "Check CT direction, meter placement and inverter grid readings.");
    else if (diff > RECONCILIATION_ALERT_W) add("grid-reconciliation-watch", "warning", "GRID RECONCILIATION WATCH", `Tuya and inverter grid readings differ by about ${Math.round(diff)} W.`, "Check whether the difference persists before recalibration.");
  }
  return alerts;
}
async function evaluateAndNotify(live) {
  if (notificationCheckInFlight) return notificationCheckInFlight;
  const flags = notificationChannelFlags();
  if (!Object.values(flags).some(Boolean)) return { ok: true, skipped: true, reason: "no remote notification channel configured" };
  notificationCheckInFlight = (async () => {
    const now = Date.now();
    const active = buildLiveAlerts(live);
    const activeKeys = new Set(active.map((a) => a.key));
    const sent = [];
    for (const alert of active) {
      const prev = alertDeliveryState.get(alert.key);
      const shouldSend = !prev?.active || prev.severity !== alert.severity || now - num(prev.sentAt) >= ALERT_COOLDOWN_MS;
      alertDeliveryState.set(alert.key, { active: true, severity: alert.severity, sentAt: shouldSend ? now : prev?.sentAt || 0, title: alert.title, message: alert.message });
      if (shouldSend) sent.push({ alert, results: await dispatchNotifications(alert) });
    }
    for (const [key, prev] of alertDeliveryState.entries()) {
      if (prev.active && !activeKeys.has(key)) {
        const recovered = { key: `${key}-recovered`, severity: "info", title: `${prev.title || key} RECOVERED`, message: "The condition is no longer active in the latest telemetry.", isRecovery: true };
        alertDeliveryState.set(key, { ...prev, active: false, sentAt: now });
        sent.push({ alert: recovered, results: await dispatchNotifications(recovered) });
      }
    }
    return { ok: true, activeAlerts: active.length, sent };
  })().finally(() => { notificationCheckInFlight = null; });
  return notificationCheckInFlight;
}
async function notificationHistory(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  if (!pool || !dbReady) return { ok: true, events: [], note: "PostgreSQL is required for persistent notification history." };
  const r = await pool.query(`
    SELECT id, created_at, alert_key, severity, title, message, channels, is_recovery
    FROM master_notification_events_v1 ORDER BY created_at DESC LIMIT $1
  `, [safeLimit]);
  return { ok: true, events: r.rows };
}

function compactAiSystem(system) {
  if (!system) return null;
  return {
    key: system.key,
    name: system.name,
    online: system.online !== false,
    solarW: num(system.solarW),
    loadW: num(system.loadW ?? system.siteDemandW),
    gridW: num(system.gridW),
    smartLoadW: num(system.smartLoadW),
    acInputW: num(system.acInputW),
    batteryPct: system.batteryPct == null ? null : num(system.batteryPct),
    batteryW: num(system.batteryW),
    tempC: num(system.temp ?? system.tempC),
    updatedAt: system.updatedAt || null
  };
}
async function buildAiTelemetryContext() {
  const [liveResult, analyticsResult, energyResult] = await Promise.allSettled([
    fetchLive({ store: false, cacheMs: 4500 }),
    fetchAnalytics(),
    fetchEnergy("T")
  ]);
  const liveData = liveResult.status === "fulfilled" ? liveResult.value : null;
  const analyticsData = analyticsResult.status === "fulfilled" ? analyticsResult.value : null;
  const energyData = energyResult.status === "fulfilled" ? energyResult.value : null;
  const meter = liveData?.meter || null;
  return {
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Karachi",
    site: "Raja Fraz Solar Estate",
    topology: {
      installedPvKw: TOTAL_PV_INSTALLED_W / 1000,
      monitoredPvKw: CURRENT_MONITORED_PV_W / 1000,
      pv14000: PV14000_API_BASE ? "Fronus Meta 10kW, 6.78 kWp PV; telemetry configured" : "Fronus Meta 10kW, 6.78 kWp physically installed; new WiFi logger pending; intentionally excluded from live totals",
      pv9000: "Fronus Meta 6kW; one active string of 8 × 545 W = 4.36 kWp; reassigned WiFi logger; feeds Matrix UPS and Smart Load",
      matrix: "Fronus Matrix 6kW used as PV-less UPS",
      physicalMeter: "Tuya grid meter",
      matrixLoadExcludedFromSiteDemandWhenContainedInPv9000: PV9000_LOAD_INCLUDES_UPS
    },
    live: liveData ? {
      complete: liveData.complete,
      connected: liveData.connected,
      systems: {
        pv14000: compactAiSystem(liveData.systems?.pv14000),
        pv9000: compactAiSystem(liveData.systems?.pv9000),
        matrix: compactAiSystem(liveData.systems?.matrix),
        combined: compactAiSystem(liveData.systems?.combined)
      },
      physicalGrid: meter ? {
        online: Boolean(meter.online), mode: meter.mode, powerW: num(meter.powerW),
        importW: num(meter.importW), exportW: num(meter.exportW), voltage: meter.voltage,
        currentA: meter.currentA, powerFactor: meter.powerFactor, temperatureC: meter.temperatureC,
        importKwh: meter.importKwh, exportKwh: meter.exportKwh, updatedAt: meter.updatedAt,
        directionSource: meter.directionSource
      } : null,
      errors: liveData.errors || {}
    } : { error: liveResult.reason?.message || "Live telemetry unavailable" },
    analytics: analyticsData || { error: analyticsResult.reason?.message || "Analytics unavailable" },
    todayEnergy: energyData ? {
      complete: energyData.complete,
      pv14000: energyData.pv14000,
      pv9000: energyData.pv9000,
      matrix: energyData.matrix,
      combined: energyData.combined,
      errors: energyData.errors || {}
    } : { error: energyResult.reason?.message || "Today energy unavailable" },
    safety: {
      aiHasControlTools: false,
      masterIsReadOnly: true,
      note: "AI can analyze and recommend only. It cannot switch Tuya, change breaker protection, or write inverter settings."
    }
  };
}
function cleanAiHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((item) => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    text: String(item?.text || "").trim().slice(0, 800)
  })).filter((item) => item.text);
}
function extractOpenAiText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}
function extractGeminiText(data) {
  const parts = [];
  for (const candidate of Array.isArray(data?.candidates) ? data.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (typeof part?.text === "string" && part.text.trim()) parts.push(part.text.trim());
    }
  }
  return parts.join("\n").trim();
}
async function callGemini(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "Raja-Fraz-Master-AI/2.0"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS
        }
      })
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.error?.status || `Gemini HTTP ${response.status}`;
      const error = new Error(String(detail).slice(0, 500));
      error.status = response.status;
      error.provider = "Gemini";
      throw error;
    }
    const answer = extractGeminiText(data);
    if (!answer) {
      const finish = data?.candidates?.[0]?.finishReason;
      const blocked = data?.promptFeedback?.blockReason;
      const suffix = blocked ? ` (${blocked})` : finish ? ` (${finish})` : "";
      const error = new Error(`Gemini returned no text response${suffix}`);
      error.provider = "Gemini";
      throw error;
    }
    const usage = data?.usageMetadata || {};
    return {
      answer,
      provider: "Gemini",
      model: data?.modelVersion || GEMINI_MODEL,
      responseId: data?.responseId || null,
      usage: {
        inputTokens: num(usage.promptTokenCount),
        outputTokens: num(usage.candidatesTokenCount),
        totalTokens: num(usage.totalTokenCount)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}
async function callOpenAi(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Raja-Fraz-Master-AI/2.0"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: prompt,
        store: false,
        max_output_tokens: AI_MAX_OUTPUT_TOKENS
      })
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.error || `OpenAI HTTP ${response.status}`;
      const error = new Error(String(detail).slice(0, 500));
      error.status = response.status;
      error.provider = "OpenAI";
      throw error;
    }
    const answer = extractOpenAiText(data);
    if (!answer) {
      const error = new Error("OpenAI returned no text response");
      error.provider = "OpenAI";
      throw error;
    }
    return {
      answer,
      provider: "OpenAI",
      model: data?.model || OPENAI_MODEL,
      responseId: data?.id || null,
      usage: data?.usage ? {
        inputTokens: num(data.usage.input_tokens),
        outputTokens: num(data.usage.output_tokens),
        totalTokens: num(data.usage.total_tokens)
      } : null
    };
  } finally {
    clearTimeout(timer);
  }
}
async function askSolarAi(message, history) {
  const telemetry = await buildAiTelemetryContext();
  const prior = cleanAiHistory(history);
  const prompt = `You are the Raja Fraz Solar AI Copilot for a real solar/UPS monitoring dashboard in Pakistan.

Rules:
- Use the TELEMETRY SNAPSHOT below as the source of truth for current readings. If a source is offline/stale/missing, say that clearly and do not invent a value.
- Understand the current topology: PV9000 is the only live-monitored solar inverter and uses one string of 8 × 545 W panels (4.36 kWp). Its WiFi logger was reassigned from PV14000. PV14000 remains physically installed at 6.78 kWp but is intentionally excluded from live totals until a new logger is installed. PV9000 feeds the Matrix UPS; Matrix is PV-less; Tuya is the independent physical utility meter.
- Never describe PV14000 as failed or offline when its logger is unconfigured; say "logger pending" or "intentionally unmonitored". Physical installed PV is 11.14 kWp, while currently monitored PV is 4.36 kWp.
- Matrix downstream load can already be included in PV9000 load, so do not double-count it.
- Tuya Consumption means grid import and Generate means grid export when that direction is confirmed.
- The dashboard's guardrails are monitoring targets, not automatic control: night import 5 kW and day export 6 kW unless telemetry config says otherwise.
- You are READ-ONLY. Never claim you switched a breaker, changed an inverter, changed Smart Life, or applied a protection threshold.
- Do not provide guessed RAW Tuya DP bytes or unsafe live-mains write commands. For protection/control changes, recommend verification and a qualified electrician/installer where appropriate.
- Be concise, practical and visually engaging. Prefer Roman Urdu/Hinglish unless the user asks in English. Use watts/kW/kWh and PKR clearly.
- Never produce a dull wall of text. Start with one punchy verdict line using an appropriate emoji and a status word such as NORMAL, WATCH, ACTION or CRITICAL.
- Use short Markdown sections with emojis, bold key readings, and compact bullets. Good section names include: ⚡ Live Verdict, 📊 Key Numbers, 🔍 Why, 🛠 What To Do, 🚨 Urgency.
- Keep most answers to 4-8 short bullets/blocks. Do not repeat the same reading in multiple sections.
- When diagnosing, separate observation/cause/action/urgency, but make it look like a modern control-room briefing rather than a report.

RECENT CHAT:
${prior.length ? prior.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n") : "None"}

TELEMETRY SNAPSHOT:
${JSON.stringify(telemetry)}

USER QUESTION:
${String(message).trim().slice(0, 1800)}`;

  let result = null;
  let primaryError = null;
  if (GEMINI_API_KEY) {
    try {
      result = await callGemini(prompt);
    } catch (error) {
      primaryError = error;
      if (!OPENAI_API_KEY) throw error;
    }
  }
  if (!result && OPENAI_API_KEY) {
    result = await callOpenAi(prompt);
  }
  if (!result) throw primaryError || new Error("AI is not configured. Add GEMINI_API_KEY in Render Environment.");
  return {
    ok: true,
    answer: result.answer,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    readOnly: true,
    telemetryAt: telemetry.generatedAt,
    fallbackUsed: Boolean(primaryError && result.provider === "OpenAI"),
    primaryError: primaryError ? String(primaryError.message || primaryError).slice(0, 220) : null,
    usage: result.usage || null
  };
}
function staticPath(urlPath) {
  const clean = urlPath.split("?")[0];
  const rel = clean === "/" ? "index.html" : (clean === "/display" || clean === "/display/") ? "display.html" : decodeURIComponent(clean).replace(/^\/+/, "");
  const abs = resolve(APP_DIR, normalize(rel));
  const root = resolve(APP_DIR) + sep;
  return abs.startsWith(root) ? abs : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/master/wake") return json(res, 200, await wakeAllSources({ force: url.searchParams.get("force") === "1" }));
    if (url.pathname === "/api/master/live") return json(res, 200, await fetchLive());
    if (url.pathname === "/api/master/energy") return json(res, 200, await fetchEnergy(String(url.searchParams.get("period") || "T")));
    if (url.pathname === "/api/master/history") return json(res, 200, await fetchHistory(Math.max(1, Math.min(720, num(url.searchParams.get("hours"), 24)))));
    if (url.pathname === "/api/master/history/status") return json(res, 200, await historyStats());
    if (url.pathname === "/api/master/collect") {
      const live = await fetchLive({ store: false, cacheMs: 0 });
      const stored = await storeSample(live, true);
      return json(res, 200, { ok: true, stored, updatedAt: live.updatedAt, history: await historyStats() });
    }
    if (url.pathname === "/api/master/analytics") return json(res, 200, await fetchAnalytics());
    if (url.pathname === "/api/master/powersmart/status") {
      const session = powerSmartSession(req);
      return json(res, 200, powerSmartPublicState(session));
    }
    if (url.pathname === "/api/master/powersmart/data") {
      const session = powerSmartSession(req);
      if (!session) return json(res, 401, { ok: false, connected: false, error: "Connect your Power Smart account first." });
      return json(res, 200, await powerSmartFetch(session, { force: url.searchParams.get("fresh") === "1" }));
    }
    if (url.pathname === "/api/master/powersmart/connect") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!powerSmartSameOrigin(req)) return json(res, 403, { ok: false, error: "Invalid request origin." });
      const rate = powerSmartConsumeSignIn(req);
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return json(res, 429, { ok: false, error: "Too many sign-in attempts. Please wait before trying again." });
      }
      const body = await readJsonBody(req, 16_384);
      const email = String(body?.email || "").trim().slice(0, 160);
      const cnic = powerSmartCleanRef(body?.cnic);
      const password = String(body?.password || "");
      if (!email || !password) return json(res, 400, { ok: false, error: "Power Smart email and password are required." });
      if (password.length > 256) return json(res, 400, { ok: false, error: "Invalid password length." });
      const signedIn = await powerSmartSignIn(email, cnic, password);
      const selected = signedIn.meters.find((m) => m.isDefault) || signedIn.meters[0];
      const id = randomBytes(32).toString("base64url");
      const session = {
        token: signedIn.token,
        accountName: signedIn.accountName,
        meters: signedIn.meters,
        selectedMeterId: selected.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + POWER_SMART_SESSION_MS,
        lastFetchAt: 0,
        cache: null
      };
      powerSmartSessions.set(id, session);
      powerSmartSignInAttempts.delete(aiClientIp(req));
      powerSmartSetCookie(req, res, id);
      let data = null;
      let dataError = null;
      try { data = await powerSmartFetch(session, { force: true }); }
      catch (error) { dataError = String(error.message || error).slice(0, 260); }
      return json(res, 200, { ...powerSmartPublicState(session), data, dataError });
    }
    if (url.pathname === "/api/master/powersmart/select-meter") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!powerSmartSameOrigin(req)) return json(res, 403, { ok: false, error: "Invalid request origin." });
      const session = powerSmartSession(req);
      if (!session) return json(res, 401, { ok: false, connected: false, error: "Power Smart session expired. Sign in again." });
      const body = await readJsonBody(req, 4096);
      const meterId = String(body?.meterId || "").slice(0, 20);
      if (!session.meters.some((m) => m.id === meterId)) return json(res, 400, { ok: false, error: "That meter is not registered on this account." });
      session.selectedMeterId = meterId;
      session.cache = null;
      session.lastFetchAt = 0;
      const data = await powerSmartFetch(session, { force: true });
      return json(res, 200, { ...powerSmartPublicState(session), data });
    }
    if (url.pathname === "/api/master/powersmart/disconnect") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!powerSmartSameOrigin(req)) return json(res, 403, { ok: false, error: "Invalid request origin." });
      const id = powerSmartCookieMap(req).rf_ps;
      if (id) powerSmartSessions.delete(id);
      powerSmartSetCookie(req, res, "", 0);
      return json(res, 200, { ok: true, connected: false });
    }
    if (url.pathname === "/api/master/ai/status") return json(res, 200, aiStatus());
    if (url.pathname === "/api/master/ai/chat") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!GEMINI_API_KEY && !OPENAI_API_KEY) return json(res, 503, { ok: false, error: "AI Copilot is not configured. Add GEMINI_API_KEY in Render Environment." });
      if (!aiPinAccepted(req)) return json(res, 401, { ok: false, error: "AI PIN is incorrect." });
      const rate = consumeAiRateLimit(req);
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return json(res, 429, { ok: false, error: `AI request limit reached. Try again in about ${Math.ceil(rate.retryAfterSeconds / 60)} minute(s).` });
      }
      const body = await readJsonBody(req);
      const message = String(body?.message || "").trim();
      if (!message) return json(res, 400, { ok: false, error: "Message is required." });
      if (message.length > 1800) return json(res, 400, { ok: false, error: "Message is too long (max 1800 characters)." });
      return json(res, 200, await askSolarAi(message, body?.history));
    }
    if (url.pathname === "/api/master/notifications/status") return json(res, 200, await notificationStatus());
    if (url.pathname === "/api/master/notifications/history") return json(res, 200, await notificationHistory(url.searchParams.get("limit")));
    if (url.pathname === "/api/master/notifications/subscribe") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!notificationPinAccepted(req)) return json(res, 401, { ok: false, error: "Notification PIN is incorrect." });
      if (!webPushConfigured) return json(res, 503, { ok: false, error: "Web Push is not configured. Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Render." });
      const body = await readJsonBody(req);
      const subscription = await savePushSubscription(body?.subscription || body);
      return json(res, 200, { ok: true, endpoint: subscription.endpoint, subscriptions: await countPushSubscriptions() });
    }
    if (url.pathname === "/api/master/notifications/unsubscribe") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!notificationPinAccepted(req)) return json(res, 401, { ok: false, error: "Notification PIN is incorrect." });
      const body = await readJsonBody(req);
      await deletePushSubscription(body?.endpoint);
      return json(res, 200, { ok: true, subscriptions: await countPushSubscriptions() });
    }
    if (url.pathname === "/api/master/notifications/test") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!notificationPinAccepted(req)) return json(res, 401, { ok: false, error: "Notification PIN is incorrect." });
      const body = await readJsonBody(req);
      const channel = String(body?.channel || "all").trim();
      const allowed = new Set(["all", "webPush", "telegram", "whatsapp", "sms"]);
      if (!allowed.has(channel)) return json(res, 400, { ok: false, error: "Unknown notification channel." });
      const live = await fetchLive({ store: false, cacheMs: 4500 }).catch(() => null);
      const c = live?.systems?.combined || {};
      const m = live?.meter || {};
      const testAlert = {
        key: `manual-test-${channel}`, severity: "info", title: "NOTIFICATION TEST",
        message: `Master Dashboard test • Solar ${Math.round(num(c.solarW))} W • Demand ${Math.round(num(c.siteDemandW))} W • Grid ${String(m.mode || "UNKNOWN")} ${Math.round(num(m.powerW))} W.`,
        action: "No action required — this is a test."
      };
      const results = await dispatchNotifications(testAlert, { channels: channel === "all" ? null : [channel] });
      return json(res, 200, { ok: true, channel, results });
    }
    if (url.pathname === "/api/master/notifications/check") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      if (!notificationPinAccepted(req)) return json(res, 401, { ok: false, error: "Notification PIN is incorrect." });
      const live = await fetchLive({ store: false, cacheMs: 0 });
      return json(res, 200, await evaluateAndNotify(live));
    }
    if (url.pathname === "/api/master/weather") return json(res, 200, await fetchWeather());
    if (url.pathname === "/api/master/tuya-energy-stats") return json(res, 200, await fetchTuyaEnergyStats());
    if (url.pathname === "/api/master/tuya-energy") return json(res, 200, await fetchTuyaEnergyRange({
      type: url.searchParams.get("type"),
      date: url.searchParams.get("date"),
      month: url.searchParams.get("month")
    }));
    if (url.pathname === "/api/health") return json(res, 200, {
      success: true,
      service: "Raja Fraz Master Solar Command Center - V38 Power Smart",
      pv14000: { base: PV14000_API_BASE || null, configured: Boolean(PV14000_API_BASE), state: PV14000_API_BASE ? "configured" : "waiting-for-new-wifi-logger", authConfigured: Boolean(PV14000_PASSWORD) },
      pv9000: { base: PV9000_API_BASE || null, configured: Boolean(PV9000_API_BASE), authConfigured: Boolean(PV9000_PASSWORD) },
      matrix: { base: MATRIX_API_BASE, configured: Boolean(MATRIX_API_BASE), role: "UPS", pvInstalledW: 0 },
      capacities: { pv14000PvW: PV14000_PV_INSTALLED_W, pv14000AcW: PV14000_AC_CAPACITY_W, pv9000PvW: PV9000_PV_INSTALLED_W, pv9000AcW: PV9000_AC_CAPACITY_W, matrixAcW: MATRIX_AC_CAPACITY_W, totalPvW: TOTAL_PV_INSTALLED_W, monitoredPvW: CURRENT_MONITORED_PV_W },
      topology: { pv9000FeedsMatrix: true, matrixIsUps: true, smartLoadSource: "PV9000", pv9000Strings: 1, pv9000Panels: 8, pv9000PanelWatts: 545, pv14000Telemetry: PV14000_API_BASE ? "configured" : "logger-pending", pv9000LoadIncludesUps: PV9000_LOAD_INCLUDES_UPS, pv9000LoadIncludesSmart: PV9000_LOAD_INCLUDES_SMART },
      powerSmart: { configured: true, accountApi: POWER_SMART_APP_BASE, sessionHours: POWER_SMART_SESSION_HOURS, instantMdmEmbedded: false, mode: "owner-account-session" },
      intelligence: { nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W, dayModeStart: DAY_MODE_START, dayModeEnd: DAY_MODE_END, batteryCapacityKwh: BATTERY_CAPACITY_KWH || null, exportRatePkr: EXPORT_RATE },
      ai: { ...aiProviderState(), configured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY), pinRequired: Boolean(AI_ACCESS_PIN), readOnly: true },
      notifications: await notificationStatus(),
      history: await historyStats()
    });

    const path = staticPath(url.pathname);
    if (!path || !existsSync(path)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const body = readFileSync(path);
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(body);
  } catch (error) {
    json(res, Number(error.status) || 500, { ok: false, error: error.message });
  }
});

await initDb();
server.listen(PORT, () => {
  console.log(`Raja Fraz Three-Inverter Master Dashboard running on ${PORT}`);
  // Start waking dependencies as soon as Master itself is awake. The browser's
  // /api/master/wake call reuses this same in-flight promise.
  const timer = setTimeout(() => {
    wakeAllSources().catch((error) => console.error("Source wake-up:", error.message));
  }, 500);
  timer.unref?.();
});

setInterval(async () => {
  try {
    if (!dbReady) await initDb();
    const current = await fetchLive({ store: false, cacheMs: 0 });
    if (dbReady) await storeSample(current);
    evaluateAndNotify(current).catch((error) => console.error("Notification monitor:", error.message));
  } catch (error) {
    console.error("Background collector:", error.message);
  }
}, HISTORY_SAMPLE_SECONDS * 1000).unref();
