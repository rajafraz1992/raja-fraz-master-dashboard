import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = join(__dirname, "app");
const PORT = Number(process.env.PORT || 10000);

// SYSTEM 01 - new primary solar inverter. Legacy META_* variables are supported
// so the existing Render service can be upgraded without breaking authentication.
const PV14000_API_BASE = String(
  process.env.PV14000_API_BASE ||
  process.env.META_API_BASE ||
  "https://inverterzone-dashboard.onrender.com"
).replace(/\/$/, "");
const PV14000_USER = String(
  process.env.PV14000_DASHBOARD_USER || process.env.META_DASHBOARD_USER || "admin"
).trim() || "admin";
const PV14000_PASSWORD = String(
  process.env.PV14000_DASHBOARD_PASSWORD || process.env.META_DASHBOARD_PASSWORD || ""
);

// SYSTEM 02 - Fronus Meta 6kW PV9000. This is a third upstream data source,
// so its URL must be supplied in Render as PV9000_API_BASE.
const PV9000_API_BASE = String(process.env.PV9000_API_BASE || "").replace(/\/$/, "");
const PV9000_USER = String(process.env.PV9000_DASHBOARD_USER || PV14000_USER || "admin").trim() || "admin";
const PV9000_PASSWORD = String(process.env.PV9000_DASHBOARD_PASSWORD || PV14000_PASSWORD || "");

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
const SITE_UPSTREAM_AC_CAPACITY_W = PV14000_AC_CAPACITY_W + PV9000_AC_CAPACITY_W;

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
  return normalizeSolarInverter(payload, {
    key: "pv9000",
    name: "FRONUS META 6KW - PV9000",
    model: "PV9000",
    pvInstalledW: PV9000_PV_INSTALLED_W,
    acCapacityW: PV9000_AC_CAPACITY_W
  });
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
    online: systemsPresent === 3,
    connectedSystems: systemsPresent,
    totalSystems: 3,
    solarW: solarSum("solarW"),
    pvInstalledW: TOTAL_PV_INSTALLED_W,
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
    health: systemsPresent === 3 ? "Excellent" : "Partial",
    topology: {
      pv9000FeedsMatrix: true,
      matrixIsUps: true,
      matrixPvInstalledW: 0,
      smartLoadSource: "pv9000",
      utilityGridSources: ["pv14000", "pv9000"],
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
    getPv14000Json(`/api/energy?period=${encodeURIComponent(safePeriod)}`).then((p) => normalizeEnergy(p, safePeriod)),
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
    complete: Boolean(pv14000 && pv9000 && matrix),
    period: safePeriod,
    pv14000,
    pv9000,
    matrix,
    combined,
    rate: RATE,
    topology: {
      matrixEnergyExcludedFromSiteTotals: PV9000_LOAD_INCLUDES_UPS,
      matrixGridExcludedFromSiteTotals: true,
      smartLoadBelongsTo: "pv9000"
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
    getPv14000Json("/api/live?fresh=1").then(normalizePv14000),
    getPv9000Json("/api/live?fresh=1").then(normalizePv9000),
    getJson(`${MATRIX_API_BASE}/api/matrix`).then(normalizeMatrixUps),
    getJson(`${TUYA_API_BASE}/api/meter`).then(normalizeTuyaMeter)
  ]);

  if (aResult.status === "fulfilled") systems.pv14000 = aResult.value;
  else errors.pv14000 = sourceHint("PV14000", aResult.reason);
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
    complete: connected === 3,
    connected,
    totalSystems: 3,
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
      batteryKwh: BATTERY_CAPACITY_KWH || null
    },
    guardrails: {
      nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W,
      dayModeStart: DAY_MODE_START, dayModeEnd: DAY_MODE_END, exportRatePkr: EXPORT_RATE,
      targetDailyYieldKwhPerKwp: TARGET_DAILY_YIELD_KWH_PER_KWP || null,
      reconciliationAlertW: RECONCILIATION_ALERT_W, alertTempC: ALERT_TEMP_C
    },
    topology: systems.combined.topology,
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
    getPv14000Json(`/api/history?hours=${hours}`),
    getPv9000Json(`/api/history?hours=${hours}`),
    getJson(`${MATRIX_API_BASE}/api/history?hours=${hours}`)
  ]);
  return {
    ok: true,
    pv14000: aResult.status === "fulfilled" ? normalizeHistory(aResult.value, "solar") : [],
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
  const solarCapacityPct = TOTAL_PV_INSTALLED_W > 0 ? num(c.solarW) / TOTAL_PV_INSTALLED_W * 100 : 0;
  return {
    ok: Boolean(live.ok), updatedAt: Date.now(), timezone: "Asia/Karachi",
    mode: { dayMode: clock.dayMode, label: clock.label, dayStart: DAY_MODE_START, dayEnd: DAY_MODE_END },
    config: {
      nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W,
      electricityRatePkr: RATE, exportRatePkr: EXPORT_RATE,
      batteryCapacityKwh: BATTERY_CAPACITY_KWH || null,
      targetDailyYieldKwhPerKwp: TARGET_DAILY_YIELD_KWH_PER_KWP || null,
      reconciliationAlertW: RECONCILIATION_ALERT_W, alertTempC: ALERT_TEMP_C
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
function staticPath(urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
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
    if (url.pathname === "/api/master/weather") return json(res, 200, await fetchWeather());
    if (url.pathname === "/api/master/tuya-energy-stats") return json(res, 200, await fetchTuyaEnergyStats());
    if (url.pathname === "/api/master/tuya-energy") return json(res, 200, await fetchTuyaEnergyRange({
      type: url.searchParams.get("type"),
      date: url.searchParams.get("date"),
      month: url.searchParams.get("month")
    }));
    if (url.pathname === "/api/health") return json(res, 200, {
      success: true,
      service: "Raja Fraz Master Solar Command Center - Three Inverter Edition",
      pv14000: { base: PV14000_API_BASE, configured: Boolean(PV14000_API_BASE), authConfigured: Boolean(PV14000_PASSWORD) },
      pv9000: { base: PV9000_API_BASE || null, configured: Boolean(PV9000_API_BASE), authConfigured: Boolean(PV9000_PASSWORD) },
      matrix: { base: MATRIX_API_BASE, configured: Boolean(MATRIX_API_BASE), role: "UPS", pvInstalledW: 0 },
      capacities: { pv14000PvW: PV14000_PV_INSTALLED_W, pv14000AcW: PV14000_AC_CAPACITY_W, pv9000PvW: PV9000_PV_INSTALLED_W, pv9000AcW: PV9000_AC_CAPACITY_W, matrixAcW: MATRIX_AC_CAPACITY_W, totalPvW: TOTAL_PV_INSTALLED_W },
      topology: { pv9000FeedsMatrix: true, matrixIsUps: true, smartLoadSource: "PV9000", pv9000LoadIncludesUps: PV9000_LOAD_INCLUDES_UPS, pv9000LoadIncludesSmart: PV9000_LOAD_INCLUDES_SMART },
      intelligence: { nightImportLimitW: NIGHT_IMPORT_LIMIT_W, dayExportLimitW: DAY_EXPORT_LIMIT_W, dayModeStart: DAY_MODE_START, dayModeEnd: DAY_MODE_END, batteryCapacityKwh: BATTERY_CAPACITY_KWH || null, exportRatePkr: EXPORT_RATE },
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
    json(res, 500, { ok: false, error: error.message });
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
    if (dbReady) {
      const current = await fetchLive({ store: false, cacheMs: 0 });
      await storeSample(current);
    }
  } catch (error) {
    console.error("Background collector:", error.message);
  }
}, HISTORY_SAMPLE_SECONDS * 1000).unref();
