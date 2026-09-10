import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamGate, rateLimitError } from "../upstream-requests.mjs";
import { getJson, fetchLive, normalizePv14000 } from "../server.mjs";

test("concurrent resource reads share one upstream call", async () => {
  const gate = createUpstreamGate(); let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const operation = async () => { calls++; await blocked; return { watts: 900 }; };
  const a = gate.run("https://one.example/live", operation), b = gate.run("https://one.example/live", operation);
  release(); assert.deepEqual(await a, await b); assert.equal(calls, 1);
});
test("HTTP 429 honors Retry-After across paths on the same origin", async () => {
  let clock = 100000, calls = 0; const gate = createUpstreamGate({ now: () => clock });
  const limited = () => { calls++; throw rateLimitError("120", clock); };
  await assert.rejects(gate.run("https://one.example/live", limited), error => error.status === 429 && error.retryAt === 220000);
  await assert.rejects(gate.run("https://one.example/energy", limited), /retry in 120 seconds/);
  assert.equal(calls, 1);
  assert.equal(await gate.run("https://two.example/live", () => 2), 2);
  clock = 220000; assert.equal(await gate.run("https://one.example/live", () => { calls++; return 9; }), 9); assert.equal(calls, 2);
});
test("429 without Retry-After backs off progressively and never loops immediately", async () => {
  let clock = 100000; const gate = createUpstreamGate({ now: () => clock });
  const limited = () => { throw rateLimitError(null, clock); };
  await assert.rejects(gate.run("https://backoff.example/live", limited), error => error.retryAfterMs === 30000);
  clock += 30000;
  await assert.rejects(gate.run("https://backoff.example/live", limited), error => error.retryAfterMs === 60000);
});
test("Retry-After dates and ordinary errors preserve their semantics", async () => {
  const now = Date.parse("2026-09-09T15:00:00Z");
  assert.equal(rateLimitError("Wed, 09 Sep 2026 15:02:00 GMT", now).retryAfterMs, 120000);
  assert.equal(rateLimitError("invalid", now).retryAfterMs, null);
  const gate = createUpstreamGate();
  await assert.rejects(gate.run("https://auth.example/live", () => { const e = new Error("Unauthorized"); e.status = 401; throw e; }), /Unauthorized/);
  assert.equal(await gate.run("https://auth.example/live", () => 7), 7);
});
test("non-JSON HTTP 429 is reported as rate limiting, not a waking service", async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("<h1>Too Many Requests</h1>", { status: 429, headers: { "Retry-After": "60" } }); };
    await assert.rejects(getJson("https://rate-test.example/live"), error => error.status === 429 && error.code === "UPSTREAM_RATE_LIMITED" && !error.message.includes("waking"));
    await assert.rejects(getJson("https://rate-test.example/energy"), /rate limited/); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test("concurrent master requests share the same four-source collection", async () => {
  const original = globalThis.fetch; let calls = 0, forcedPv9000 = false;
  try {
    globalThis.fetch = async url => {
      calls++; if(String(url).includes("inverterzone-dashboard") && String(url).includes("fresh=1"))forcedPv9000 = true;
      await new Promise(resolve => setImmediate(resolve));
      return new Response(JSON.stringify({ success: true, solarW: 0, acOutW: 1000, gridW: 1050, gridV: 220, fanSpeed: 40 }));
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => fetchLive({ store: false, cacheMs: 0 })));
    assert.equal(calls, 4); assert.equal(forcedPv9000, false);
    assert.equal(results[0].systems.pv9000.loadW, 1000);
    for(const result of results)assert.strictEqual(result, results[0]);
  } finally { globalThis.fetch = original; }
});
test("cached collector frames retain original acquisition time", () => {
  const timestamp = Date.parse("2026-09-09T10:00:00Z");
  const value = normalizePv14000({ cached: true, collectedAt: timestamp, data: { solarW: 0, acOutW: 1100, gridW: 1140 } });
  assert.equal(value.updatedAt, timestamp); assert.equal(value.sourceCached, true);
});
