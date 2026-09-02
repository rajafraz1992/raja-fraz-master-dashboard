function findArrays(value, out = []) {
  if (Array.isArray(value)) {
    if (value.some((row) => row && typeof row === "object" && !Array.isArray(row))) out.push(value);
    for (const row of value) findArrays(row, out);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) findArrays(child, out);
  }
  return out;
}

function numeric(row, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row || {}, key)) continue;
    const match = String(row[key] ?? "").replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
    if (match && Number.isFinite(Number(match[0]))) return Number(match[0]);
  }
  return null;
}

function firstText(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && String(value).trim()) return String(value).trim().slice(0, 80);
  }
  return "";
}

function monthIndex(value) {
  const text = String(value || "").trim();
  const number = Number(text);
  if (Number.isInteger(number) && number >= 1 && number <= 12) return number;
  const key = text.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3);
  const named = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  return named[key] || null;
}

function publicRow(row) {
  if (!row) return null;
  const { sortKey, ...safe } = row;
  return safe;
}

function parseDailyDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})[-/]([A-Za-z]{3,9}|\d{1,2})[-/](\d{2,4})$/);
  if (match) {
    const month = monthIndex(match[2]);
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    if (!month) return null;
    return new Date(Date.UTC(year, month - 1, Number(match[1])));
  }
  const direct = Date.parse(text);
  return Number.isFinite(direct) ? new Date(direct) : null;
}

function dailyValue(row, directKeys, currentKeys = [], previousKeys = []) {
  const direct = numeric(row, directKeys);
  if (direct != null) return Math.abs(direct);
  const current = numeric(row, currentKeys);
  const previous = numeric(row, previousKeys);
  if (current == null) return 0;
  if (previous == null) return Math.abs(current);
  return Math.max(0, current - previous);
}

export function normalizePowerSmartDaily(payload) {
  const arrays = findArrays(payload);
  const dateKeys = ["readingDate", "reading_date", "daily_data_reporting_time", "reportingDate", "reportDate", "date", "datetime", "time"];
  const directKeys = ["imp_p_units", "imp_op_units", "exp_p_units", "exp_op_units", "importPeak", "importOffPeak", "exportPeak", "exportOffPeak"];
  let best = [];
  let bestScore = -1;
  for (const rows of arrays) {
    const score = rows.reduce((sum, row) => sum + (firstText(row, dateKeys) ? 3 : 0) + directKeys.reduce((n, key) => n + (numeric(row, [key]) != null ? 1 : 0), 0), 0);
    if (score > bestScore) { best = rows; bestScore = score; }
  }
  const history = best.map((row, index) => {
    const dateText = firstText(row, dateKeys);
    const date = parseDailyDate(dateText);
    const importPeakKwh = dailyValue(row,
      ["imp_p_units", "importPeakUnits", "importPeakKwh", "importPeak", "peakImportUnits"],
      ["mdiReadingImportPeakCurrent", "peakImportCurrent", "currentPeakImport", "peakKwhCurrent"],
      ["mdiReadingImportPeakPrevious", "previousPeakImport", "peakImportPrevious", "peakKwhPrevious"]);
    const importOffPeakKwh = dailyValue(row,
      ["imp_op_units", "importOffPeakUnits", "importOffPeakKwh", "importOffPeak", "offPeakImportUnits"],
      ["mdiReadingImportOffPeakCurrent", "offPeakImportCurrent", "currentOffPeakImport", "offPeakKwhCurrent"],
      ["mdiReadingImportOffPeakPrevious", "previousOffPeakImport", "offPeakImportPrevious", "offPeakKwhPrevious"]);
    const exportPeakKwh = dailyValue(row,
      ["exp_p_units", "exportPeakUnits", "exportPeakKwh", "exportPeak", "peakExportUnits"],
      ["mdiReadingExportPeakCurrent", "peakExportCurrent", "currentPeakExport"],
      ["mdiReadingExportPeakPrevious", "previousPeakExport", "peakExportPrevious"]);
    const exportOffPeakKwh = dailyValue(row,
      ["exp_op_units", "exportOffPeakUnits", "exportOffPeakKwh", "exportOffPeak", "offPeakExportUnits"],
      ["mdiReadingExportOffPeakCurrent", "offPeakExportCurrent", "currentOffPeakExport"],
      ["mdiReadingExportOffPeakPrevious", "previousOffPeakExport", "offPeakExportPrevious"]);
    const importKwh = importPeakKwh + importOffPeakKwh;
    const exportKwh = exportPeakKwh + exportOffPeakKwh;
    const sortKey = date ? date.getTime() : index;
    const label = date ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date).replace(" ", "-") : (dateText || `Day ${index + 1}`);
    return { date: date ? date.toISOString().slice(0, 10) : null, label, importPeakKwh, importOffPeakKwh, exportPeakKwh, exportOffPeakKwh, importKwh, exportKwh, netKwh: importKwh - exportKwh, sortKey };
  }).filter((row) => row.date || row.importKwh || row.exportKwh);
  history.sort((a, b) => a.sortKey - b.sortKey);
  const totals = history.reduce((out, row) => {
    out.importPeakKwh += row.importPeakKwh;
    out.importOffPeakKwh += row.importOffPeakKwh;
    out.exportPeakKwh += row.exportPeakKwh;
    out.exportOffPeakKwh += row.exportOffPeakKwh;
    out.importKwh += row.importKwh;
    out.exportKwh += row.exportKwh;
    out.netKwh += row.netKwh;
    return out;
  }, { importPeakKwh:0, importOffPeakKwh:0, exportPeakKwh:0, exportOffPeakKwh:0, importKwh:0, exportKwh:0, netKwh:0 });
  return { history: history.map(publicRow), latest: publicRow(history.at(-1)), records: history.length, totals };
}

export function normalizePowerSmartMonthly(payload, now = new Date()) {
  const arrays = findArrays(payload);
  const unitKeys = ["consumption", "monthlyConsumption", "totalConsumption", "units", "unit", "kwh", "kWh", "activeEnergy", "readingDifference", "consumedUnits"];
  let best = [];
  let bestScore = -1;
  for (const rows of arrays) {
    const score = rows.reduce((sum, row) => sum + (numeric(row, unitKeys) != null ? 3 : 0) + (firstText(row, ["month", "monthName", "billingMonth", "date", "billMonth"]) ? 1 : 0), 0);
    if (score > bestScore) { best = rows; bestScore = score; }
  }
  const history = best.map((row, index) => {
    const monthText = firstText(row, ["monthName", "month", "billingMonth", "billMonth"]);
    const dateText = firstText(row, ["readingDate", "billingDate", "date", "reportedAt", "createdAt"]);
    const year = numeric(row, ["year", "billingYear", "billYear"]);
    const parsedDate = dateText && Number.isFinite(Date.parse(dateText)) ? new Date(dateText) : null;
    const month = monthIndex(monthText) || (parsedDate ? parsedDate.getUTCMonth() + 1 : null);
    const y = year || (parsedDate ? parsedDate.getUTCFullYear() : null);
    return {
      label: monthText || (dateText ? dateText.slice(0, 10) : `Reading ${index + 1}`),
      month,
      year: y,
      kwh: numeric(row, unitKeys),
      peakKwh: numeric(row, ["peakConsumption", "peakUnits", "peakKwh", "t1", "T1"]),
      offPeakKwh: numeric(row, ["offPeakConsumption", "offpeakConsumption", "offPeakUnits", "offPeakKwh", "t2", "T2"]),
      amountPkr: numeric(row, ["billAmount", "amount", "payableAmount"]),
      reportedAt: dateText || null,
      sortKey: y && month ? y * 100 + month : index
    };
  }).filter((row) => row.kwh != null || row.peakKwh != null || row.offPeakKwh != null);
  history.sort((a, b) => a.sortKey - b.sortKey);
  const pk = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" }).format(now);
  const [currentYear, currentMonth] = pk.split("-").map(Number);
  const current = history.findLast?.((row) => row.year === currentYear && row.month === currentMonth) || history.at(-1) || null;
  return { history: history.map(publicRow), current: publicRow(current), latest: publicRow(history.at(-1)), records: history.length };
}
