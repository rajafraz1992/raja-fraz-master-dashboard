import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizePowerSmartMonthly } from "../lib/powersmart-normalize.mjs";

test("normalizes, sorts and selects the current PITC month", () => {
  const result = normalizePowerSmartMonthly({
    status: 200,
    data: {
      accountRows: [{ refNo: "123" }],
      monthlyConsumption: [
        { monthName: "September", year: 2026, consumption: "216.40", billAmount: "13,502" },
        { monthName: "July", year: 2026, consumption: "630.60", peakUnits: "110.2", offPeakUnits: "520.4" },
        { monthName: "August", year: 2026, consumption: "590.20" }
      ]
    }
  }, new Date("2026-09-02T12:00:00Z"));
  assert.equal(result.records, 3);
  assert.deepEqual(result.history.map((row) => row.month), [7, 8, 9]);
  assert.equal(result.current.kwh, 216.4);
  assert.equal(result.current.amountPkr, 13502);
  assert.equal(Object.hasOwn(result.current, "sortKey"), false);
});

test("accepts alternate API field names and report dates", () => {
  const result = normalizePowerSmartMonthly({ result: [{ billingDate: "2026-06-30", consumedUnits: "411 kWh", t1: 60, t2: 351 }] }, new Date("2026-07-01T00:00:00Z"));
  assert.equal(result.records, 1);
  assert.equal(result.latest.year, 2026);
  assert.equal(result.latest.month, 6);
  assert.equal(result.latest.kwh, 411);
  assert.equal(result.latest.peakKwh, 60);
  assert.equal(result.latest.offPeakKwh, 351);
});

test("returns an empty safe shape when PITC has no monthly rows", () => {
  assert.deepEqual(normalizePowerSmartMonthly({ status: 200, data: { message: "No record" } }), { history: [], current: null, latest: null, records: 0 });
});

test("Power Smart server contains no copied MDM service credential", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  for (const forbidden of ["authorization_service", "MDM_SERVICE_HEADERS", "admin@kbk", "admin786", "privatekey:"]) {
    assert.equal(source.includes(forbidden), false, `forbidden credential marker: ${forbidden}`);
  }
  assert.match(source, /HttpOnly; SameSite=Strict/);
  assert.match(source, /powerSmartConsumeSignIn/);
  assert.equal(source.includes("session.password"), false);
});
