import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeDeviceId, normalizePv14000, normalizeEnergy } from "../server.mjs";

test("normalizes the dedicated PV14000 logger without collapsing its two MPPT inputs", () => {
  const reading = normalizePv14000({
    dataDTO: {
      deviceId: "TEST-PV14000",
      solarW: 6700,
      solarW1: 3500,
      solarV1: 355.2,
      solarA1: 9.9,
      solarW2: 3200,
      solarV2: 352.1,
      solarA2: 9.1,
      acOutW: 2100,
      gridW: -4600,
      gridV: 229.7,
      heatSinkDegC: 48,
      fanSpeed: 44
    }
  });

  assert.equal(reading.model, "PV14000");
  assert.equal(reading.pvInstalledW, 6780);
  assert.equal(reading.acCapacityW, 10000);
  assert.equal(reading.solarW, 6700);
  assert.equal(reading.pv1W, 3500);
  assert.equal(reading.pv2W, 3200);
  assert.equal(reading.pv1V, 355.2);
  assert.equal(reading.pv2V, 352.1);
  assert.equal(reading.pvCurrentA, 19);
  assert.ok(Math.abs(reading.outputCurrentA - (2100 / 229.7)) < 0.01);
  assert.ok(Math.abs(reading.gridCurrentA - (4600 / 229.7)) < 0.01);
  assert.equal(reading.outputCurrentSource, "derived-live-voltage");
  assert.equal(reading.gridCurrentSource, "derived-live-voltage");
  assert.equal(reading.fan, 44);
});

test("normalizes user-facing MAC formatting for the logger API", () => {
  assert.equal(normalizeDeviceId("8c:aa:b5:d3:b1:af"), "8CAAB5D3B1AF");
});

test("derives output and grid amperes at nominal voltage when the logger omits voltage", () => {
  const reading = normalizePv14000({ dataDTO: { solarW: 1200, acOutW: 920, gridW: -460 } });
  assert.equal(reading.outputCurrentA, 4);
  assert.equal(reading.gridCurrentA, 2);
  assert.equal(reading.outputCurrentSource, "derived-230v-nominal");
  assert.equal(reading.gridCurrentSource, "derived-230v-nominal");
});

test("normalizes official InverterZone energy totals", () => {
  const energy = normalizeEnergy({ data: { todaySolar: 18.4, todayLoad: 7.2, todayGrid: 1.3, todayNetGrid: 12.5 } }, "T");
  assert.equal(energy.solarKwh, 18.4);
  assert.equal(energy.loadKwh, 7.2);
  assert.equal(energy.importKwh, 1.3);
  assert.equal(energy.exportKwh, 12.5);
});

test("ships an upload-ready Render mapping for the PV14000 logger", async () => {
  const yaml = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(yaml, /key:\s*PV14000_DEVICE_ID/);
  assert.match(server, /inverterzone\.com\/api\/getRealtimeData/);
  assert.match(server, /refreshSeconds:\s*5/);
  assert.doesNotMatch(server, /ready-awaiting-first-data|AWAITING_FIRST_DATA/);
  assert.match(dashboard, /setInterval\(loadLive,5000\)/);
  assert.match(html, /id="combinedPvCurrent"/);
  assert.match(html, /id="combinedOutputCurrent"/);
  assert.match(html, /id="combinedGridCurrent"/);
  assert.match(html, /id="toolElec14000Pv"/);
  assert.match(html, /id="toolHead14000"/);
  assert.match(html, /id="toolMpptState"/);
  assert.match(html, /id="toolGridGuardLive"/);
  assert.match(html, /id="toolDailyNet"/);
  assert.match(html, /id="toolCircuitRunning"/);
});
