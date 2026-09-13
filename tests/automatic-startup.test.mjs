import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSources } from "../live-sources.mjs";
import { rateLimitError } from "../upstream-requests.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test("ready inverter is returned while other Render services are still sleeping", async () => {
  const slow = deferred(); let slowCalls = 0;
  const sources = createLiveSources({
    pv14000: { configured: true, read: async () => ({ solarW: 4300, updatedAt: 123 }) },
    pv9000: { configured: true, read: () => { slowCalls++; return slow.promise; } }
  });
  const partial = await sources.sample({ waitMs: 20 });
  assert.equal(partial.results.pv14000.value.solarW, 4300);
  assert.equal(partial.sources.pv9000.state, "connecting");
  assert.equal(partial.warmingUp, true);
  await sources.sample({ waitMs: 1 });
  assert.equal(slowCalls, 1, "polling must not restart a long cold-start request");
  slow.resolve({ solarW: 2900, updatedAt: 456 });
  const ready = await sources.sample({ waitMs: 100 });
  assert.equal(ready.warmingUp, false);
  assert.equal(ready.results.pv9000.value.solarW, 2900);
});
test("wake starts every configured source without waiting and skips unconfigured sources", async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const sources = createLiveSources({
    a: { configured: true, read: () => { calls++; return a.promise; } },
    b: { configured: true, read: () => { calls++; return b.promise; } },
    missing: { configured: false, read: () => { throw Error("Must not run"); } }
  });
  sources.refresh(); sources.refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(sources.snapshot().sources.missing.state, "not_configured");
  a.resolve({ watts: 1 }); b.resolve({ watts: 2 });
  await sources.sample();
});
test("warm-up HTML is retried automatically and never becomes zero telemetry", async () => {
  let clock = 100000, calls = 0;
  const sources = createLiveSources({ pv9000: { configured: true, read: async () => {
    calls++; if (calls === 1) { const e = new Error("Render loading"); e.code = "UPSTREAM_NOT_READY"; throw e; }
    return { solarW: 0, loadW: 1700, updatedAt: 789 };
  } } }, { now: () => clock });
  let result = await sources.sample();
  assert.equal(result.sources.pv9000.state, "connecting");
  assert.equal(result.results.pv9000.status, "rejected");
  await sources.sample(); assert.equal(calls, 1);
  clock += 5000; result = await sources.sample();
  assert.equal(result.sources.pv9000.ready, true);
  assert.equal(result.results.pv9000.value.loadW, 1700);
});
test("rate limits and bad authentication are not disguised as sleeping inverters", async () => {
  let clock = 100000, limitedCalls = 0, authCalls = 0;
  const sources = createLiveSources({
    limited: { configured: true, read: () => { limitedCalls++; throw rateLimitError("120", clock); } },
    auth: { configured: true, read: () => { authCalls++; const e = new Error("Unauthorized"); e.status = 401; throw e; } }
  }, { now: () => clock });
  const result = await sources.sample();
  assert.equal(result.sources.limited.state, "rate_limited");
  assert.equal(result.sources.auth.state, "authentication");
  assert.equal(result.warmingUp, false);
  clock += 10000; sources.refresh(); await sources.sample();
  assert.equal(limitedCalls, 1); assert.equal(authCalls, 1);
  clock += 110000; await sources.sample(); assert.equal(limitedCalls, 2);
});
test("a previous reading is withheld if a refresh gets stuck; time is never rewritten", async () => {
  let clock = 100000, calls = 0; const stuck = deferred();
  const sources = createLiveSources({ pv: { configured: true, read: () => ++calls === 1 ? { solarW: 1234, updatedAt: 678 } : stuck.promise } }, { now: () => clock });
  let result = await sources.sample(); assert.equal(result.results.pv.value.updatedAt, 678);
  clock += 5000; result = await sources.sample({ waitMs: 1 }); assert.equal(result.results.pv.value.updatedAt, 678);
  clock += 11000; result = await sources.sample({ waitMs: 1 }); assert.equal(result.results.pv.status, "rejected");
  assert.equal(result.sources.pv.state, "connecting");
  stuck.resolve({ solarW: 900, updatedAt: 900 }); await sources.sample();
});
