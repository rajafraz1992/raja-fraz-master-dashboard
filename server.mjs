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
      headers: { "User-Agent": "Raja-Fraz-Master/5.0", ...headers }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.error || data?.msg || data?.raw || `HTTP ${response.status}`;
      const error = new Error(String(detail).slice(0, 300));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function getDashboardJson(base, path, user, password) {
  if (!base) {
    const error = new Error("API base URL is not configured");
    error.code = "NOT_CONFIGURED";
    throw error;
  }
  const auth = authHeader(user, password);
  return getJson(`${base}${path}`, { headers: auth ? { Authorization: auth } : {} });
}
const getPv14000Json = (path) => getDashboardJson(PV14000_API_BASE, path, PV14000_USER, PV14000_PASSWORD);
const getPv9000Json = (path) => getDashboardJson(PV9000_API_BASE, path, PV9000_USER, PV9000_PASSWORD);

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

  if (tuyaDirectionState.importKwh != null && tuyaDirectionState.exportKwh != null && importKwh != null && exportKwh != null) {
    const di = importKwh - tuyaDirectionState.importKwh;
    const de = exportKwh - tuyaDirectionState.exportKwh;
    if (di >= -eps && de >= -eps) {
      if (de > di + eps && de > eps) detected = "EXPORTING";
      else if (di > de + eps && di > eps) detected = "IMPORTING";
    }
  }

  if (powerW < 30) detected = "IDLE";
  if (!detected && powerW >= 30) {
    const recentDirection = ["IMPORTING", "EXPORTING"].includes(tuyaDirectionState.mode) && now - tuyaDirectionState.lastDirectionAt < 15 * 60 * 1000;
    detected = recentDirection ? tuyaDirectionState.mode : "IMPORTING";
  }
  if (!detected) detected = "IDLE";

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
    voltage: asNullableNumber(s.voltage),
    currentA: asNullableNumber(s.currentA),
    powerFactor: asNullableNumber(s.powerFactor),
    temperatureC: asNullableNumber(s.temperatureC),
    importKwh,
    exportKwh,
    netKwh: asNullableNumber(s.netKwh),
    updatedAt: Number.isFinite(parsedUpdated) ? parsedUpdated : now,
    directionSource: "cumulative-counter-delta + live active power"
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
        combined_ups_load_w DOUBLE PRECISION NOT NULL DEFAULT 0
      );
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
  try {
    await pool.query(`
      INSERT INTO master_samples_v3 (
        captured_at, pv14000_online, pv9000_online, matrix_online,
        pv14000_solar_w, pv14000_load_w, pv14000_grid_w, pv14000_pv1_w, pv14000_pv2_w, pv14000_temp_c,
        pv9000_solar_w, pv9000_load_w, pv9000_grid_w, pv9000_pv1_w, pv9000_pv2_w, pv9000_smart_w, pv9000_temp_c,
        matrix_ac_input_w, matrix_load_w, matrix_battery_w, matrix_battery_pct, matrix_temp_c,
        combined_solar_w, combined_demand_w, combined_grid_w, combined_smart_w, combined_ups_load_w
      ) VALUES (
        NOW(), $1, $2, $3,
        $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26
      )
    `, [
      Boolean(live.systems.pv14000), Boolean(live.systems.pv9000), Boolean(live.systems.matrix),
      num(a.solarW), num(a.loadW), num(a.gridW), num(a.pv1W), num(a.pv2W), num(a.temp),
      num(b.solarW), num(b.loadW), num(b.gridW), num(b.pv1W), num(b.pv2W), num(b.smartLoadW), num(b.temp),
      num(u.acInputW), num(u.loadW), num(u.batteryW), u.batteryPct == null ? null : num(u.batteryPct), num(u.transformer || u.temp),
      num(c.solarW), num(c.siteDemandW), num(c.gridW), num(c.smartLoadW), num(c.upsLoadW)
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
      totalPvW: TOTAL_PV_INSTALLED_W
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
      smartLoadW: num(r.combined_smart_w), upsLoadW: num(r.combined_ups_load_w)
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
    if (url.pathname === "/api/master/live") return json(res, 200, await fetchLive());
    if (url.pathname === "/api/master/energy") return json(res, 200, await fetchEnergy(String(url.searchParams.get("period") || "T")));
    if (url.pathname === "/api/master/history") return json(res, 200, await fetchHistory(Math.max(1, Math.min(720, num(url.searchParams.get("hours"), 24)))));
    if (url.pathname === "/api/master/history/status") return json(res, 200, await historyStats());
    if (url.pathname === "/api/master/collect") {
      const live = await fetchLive({ store: false, cacheMs: 0 });
      const stored = await storeSample(live, true);
      return json(res, 200, { ok: true, stored, updatedAt: live.updatedAt, history: await historyStats() });
    }
    if (url.pathname === "/api/master/weather") return json(res, 200, await fetchWeather());
    if (url.pathname === "/api/health") return json(res, 200, {
      success: true,
      service: "Raja Fraz Master Solar Command Center - Three Inverter Edition",
      pv14000: { base: PV14000_API_BASE, configured: Boolean(PV14000_API_BASE), authConfigured: Boolean(PV14000_PASSWORD) },
      pv9000: { base: PV9000_API_BASE || null, configured: Boolean(PV9000_API_BASE), authConfigured: Boolean(PV9000_PASSWORD) },
      matrix: { base: MATRIX_API_BASE, configured: Boolean(MATRIX_API_BASE), role: "UPS", pvInstalledW: 0 },
      capacities: { pv14000PvW: PV14000_PV_INSTALLED_W, pv14000AcW: PV14000_AC_CAPACITY_W, pv9000PvW: PV9000_PV_INSTALLED_W, pv9000AcW: PV9000_AC_CAPACITY_W, matrixAcW: MATRIX_AC_CAPACITY_W, totalPvW: TOTAL_PV_INSTALLED_W },
      topology: { pv9000FeedsMatrix: true, matrixIsUps: true, smartLoadSource: "PV9000", pv9000LoadIncludesUps: PV9000_LOAD_INCLUDES_UPS, pv9000LoadIncludesSmart: PV9000_LOAD_INCLUDES_SMART },
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
      "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=120"
    });
    res.end(body);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

await initDb();
server.listen(PORT, () => console.log(`Raja Fraz Three-Inverter Master Dashboard running on ${PORT}`));

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
