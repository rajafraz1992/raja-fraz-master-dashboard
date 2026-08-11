import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = join(__dirname, "app");
const PORT = Number(process.env.PORT || 10000);
const META_API_BASE = String(process.env.META_API_BASE || "https://inverterzone-dashboard.onrender.com").replace(/\/$/, "");
const META_DASHBOARD_USER = String(process.env.META_DASHBOARD_USER || "admin").trim() || "admin";
const META_DASHBOARD_PASSWORD = String(process.env.META_DASHBOARD_PASSWORD || "");
const MATRIX_API_BASE = String(process.env.MATRIX_API_BASE || "https://fronus-matrix-dashboard.onrender.com").replace(/\/$/, "");
const RATE = Number(process.env.ELECTRICITY_RATE_PKR || 60);

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
  for (let i = 0; i < 6; i++) {
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
  if (Math.abs(gridW) < 30) return "IDLE";
  return gridW >= 0 ? "IMPORTING" : "EXPORTING";
}
function basicAuthHeader() {
  if (!META_DASHBOARD_PASSWORD) return null;
  return `Basic ${Buffer.from(`${META_DASHBOARD_USER}:${META_DASHBOARD_PASSWORD}`, "utf8").toString("base64")}`;
}
async function getJson(url, { timeoutMs = 16000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Raja-Fraz-Master/2.0", ...headers }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.error || data?.msg || data?.raw || `HTTP ${response.status}`;
      const error = new Error(String(detail).slice(0, 240));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function getMetaJson(path) {
  const auth = basicAuthHeader();
  const headers = auth ? { Authorization: auth } : {};
  return getJson(`${META_API_BASE}${path}`, { headers });
}

function normalizeMeta(payload) {
  const s = unwrap(payload);
  const solar = first(s, ["solarWatts", "solarW", "pvWatts", "PV_Total_Power"]);
  const load = first(s, ["loadWatts", "acOutW", "loadPower", "AC_out_Watt"]);
  const grid = first(s, ["gridWatts", "gridW", "gridPower", "Grid_Watt"]);
  const batteryPct = first(s, ["batteryPercentage", "battPercent", "batterySoc"], NaN);
  return {
    key: "meta", name: "Fronus Meta PV9000", online: true,
    solarW: solar,
    pv1W: first(s, ["pv1Watts", "solarW1", "pv1_power"]),
    pv2W: first(s, ["pv2Watts", "solarW2", "pv2_power"]),
    pv1V: first(s, ["pv1Voltage", "pv1V"]), pv2V: first(s, ["pv2Voltage", "pv2V"]),
    pv1A: first(s, ["pv1Ampere", "pv1A"]), pv2A: first(s, ["pv2Ampere", "pv2A"]),
    loadW: load, gridW: grid,
    gridV: first(s, ["gridVoltage", "gridV", "AC_in_Voltage"]),
    gridHz: first(s, ["gridHz", "gridFrequency"]),
    batteryPct: Number.isFinite(batteryPct) ? batteryPct : null,
    batteryW: first(s, ["batteryPowerWatts", "batteryW"], 0),
    smartLoadW: 0,
    acOutW: first(s, ["inverterOutputWatts", "acOutW"], load),
    temp: first(s, ["heatSinkTemperature", "heatSinkDegC", "inverterTemperature"], 0),
    fan: first(s, ["fanSpeed", "fan"], 0), signal: first(s, ["signal", "wifiSignal"], 0),
    todaySolar: first(s, ["todaySolar", "solarToday"], 0),
    todayLoad: first(s, ["todayLoad", "loadToday"], 0),
    todayImport: first(s, ["todayGrid", "todayImport", "gridImportToday"], 0),
    todayExport: first(s, ["todayNetGrid", "todayExport", "gridExportToday"], 0),
    health: "Excellent", updatedAt: num(s.receivedAt || s.timestamp || Date.now())
  };
}
function normalizeMatrix(payload) {
  const s = unwrap(payload);
  return {
    key: "matrix", name: "Fronus Matrix 6K", online: true,
    solarW: first(s, ["solarWatts", "solarW"]),
    pv1W: first(s, ["pv1Watts", "solarW1"]), pv2W: first(s, ["pv2Watts", "solarW2"]),
    pv1V: first(s, ["pv1Voltage", "pv1V"]), pv2V: first(s, ["pv2Voltage", "pv2V"]),
    pv1A: first(s, ["pv1Ampere", "pv1A"]), pv2A: first(s, ["pv2Ampere", "pv2A"]),
    loadW: first(s, ["loadWatts", "acOutW"]), gridW: first(s, ["gridWatts", "gridW"]),
    gridV: first(s, ["gridVoltage", "gridV"]), gridHz: first(s, ["gridHz"], 0),
    batteryPct: first(s, ["batteryPercentage", "battPercent"], null),
    batteryW: first(s, ["batteryPowerWatts", "batteryW"], 0),
    batteryV: first(s, ["batteryVoltage", "batteryV"], 0), batteryA: first(s, ["batteryCurrent", "batteryA"], 0),
    batteryMode: String(s.batteryMode || "--"),
    smartLoadW: first(s, ["smartLoadWatts"], 0),
    acOutW: first(s, ["inverterOutputWatts", "acOutW"], 0),
    temp: first(s, ["heatSinkTemperature", "radiatorTemperature", "transformerTemperature"], 0),
    transformer: first(s, ["transformerTemperature"], 0), radiator: first(s, ["radiatorTemperature"], 0),
    todaySolar: first(s, ["todaySolar"], 0), todayLoad: first(s, ["todayLoad"], 0),
    todayImport: first(s, ["todayGrid", "todayImport"], 0), todayExport: first(s, ["todayNetGrid", "todayExport"], 0),
    todaySmartLoad: first(s, ["todaySmartLoad"], 0),
    health: "Excellent", updatedAt: num(s.receivedAt || s.collectionTime || Date.now())
  };
}
function combine(meta, matrix) {
  const systems = [meta, matrix].filter(Boolean);
  const sum = (key) => systems.reduce((total, item) => total + num(item[key]), 0);
  const grid = sum("gridW");
  const normalLoad = sum("loadW");
  const smartLoad = sum("smartLoadW");
  return {
    key: "combined", name: "Combined Site", online: systems.length === 2 && systems.every((x) => x.online),
    solarW: sum("solarW"), pv1W: sum("pv1W"), pv2W: sum("pv2W"),
    loadW: normalLoad, siteDemandW: normalLoad + smartLoad,
    gridW: grid, smartLoadW: smartLoad, batteryW: sum("batteryW"),
    todaySolar: sum("todaySolar"), todayLoad: sum("todayLoad") + sum("todaySmartLoad"),
    todayImport: sum("todayImport"), todayExport: sum("todayExport"),
    gridDirection: direction(grid), health: systems.length === 2 ? "Excellent" : "Degraded"
  };
}
function metaAuthHint(error) {
  if (!error) return null;
  if (error.status === 401) return "Meta dashboard requires Basic Auth. Set META_DASHBOARD_PASSWORD in this Render service to the same password used by InverterZone.";
  return error.message;
}
async function fetchLive() {
  const systems = {};
  const errors = {};
  const [metaResult, matrixResult] = await Promise.allSettled([
    getMetaJson("/api/live?fresh=1").then(normalizeMeta),
    getJson(`${MATRIX_API_BASE}/api/matrix`).then(normalizeMatrix)
  ]);
  if (metaResult.status === "fulfilled") systems.meta = metaResult.value;
  else errors.meta = metaAuthHint(metaResult.reason);
  if (matrixResult.status === "fulfilled") systems.matrix = matrixResult.value;
  else errors.matrix = matrixResult.reason.message;
  systems.combined = combine(systems.meta, systems.matrix);
  return {
    ok: Boolean(systems.meta || systems.matrix), complete: Boolean(systems.meta && systems.matrix),
    systems, errors, updatedAt: Date.now(), refreshSeconds: 10, matrixFrameSeconds: 60, rate: RATE
  };
}
function normalizeHistory(payload) {
  const source = payload?.data || unwrap(payload)?.data || [];
  if (!Array.isArray(source)) return [];
  return source.map((p) => ({
    timestamp: num(p.timestamp || p.receivedAt || Date.now()),
    solarW: num(p.solarW), loadW: num(p.loadW), gridW: num(p.gridW),
    pv1W: num(p.pv1W), pv2W: num(p.pv2W), smartLoadW: num(p.smartLoadW)
  }));
}
async function fetchHistory(hours = 24) {
  const [metaResult, matrixResult] = await Promise.allSettled([
    getMetaJson(`/api/history?hours=${hours}`),
    getJson(`${MATRIX_API_BASE}/api/history?hours=${hours}`)
  ]);
  return {
    ok: true,
    meta: metaResult.status === "fulfilled" ? normalizeHistory(metaResult.value) : [],
    matrix: matrixResult.status === "fulfilled" ? normalizeHistory(matrixResult.value) : [],
    errors: {
      ...(metaResult.status === "rejected" ? { meta: metaAuthHint(metaResult.reason) } : {}),
      ...(matrixResult.status === "rejected" ? { matrix: matrixResult.reason.message } : {})
    }
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
    if (url.pathname === "/api/master/live") return json(res, 200, await fetchLive());
    if (url.pathname === "/api/master/history") return json(res, 200, await fetchHistory(Math.max(1, Math.min(720, num(url.searchParams.get("hours"), 24)))));
    if (url.pathname === "/api/master/weather") return json(res, 200, await fetchWeather());
    if (url.pathname === "/api/health") return json(res, 200, {
      success: true, service: "Raja Fraz Master Solar Command Center V2",
      meta: META_API_BASE, matrix: MATRIX_API_BASE,
      metaAuthConfigured: Boolean(META_DASHBOARD_PASSWORD)
    });
    const path = staticPath(url.pathname);
    if (!path || !existsSync(path)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const body = readFileSync(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream", "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=300" });
    res.end(body);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});
server.listen(PORT, () => console.log(`Raja Fraz Master Solar Command Center V2 running on ${PORT}`));
