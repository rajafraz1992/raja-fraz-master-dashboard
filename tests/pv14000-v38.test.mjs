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
  assert.equal(reading.fan, 44);
});

test("normalizes user-facing MAC formatting for the logger API", () => {
  assert.equal(normalizeDeviceId("8c:aa:b5:d3:b1:af"), "8CAAB5D3B1AF");
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
  assert.match(yaml, /key:\s*PV14000_DEVICE_ID/);
  assert.match(server, /inverterzone\.com\/api\/getRealtimeData/);
  assert.match(server, /ready-awaiting-first-data/);
});
