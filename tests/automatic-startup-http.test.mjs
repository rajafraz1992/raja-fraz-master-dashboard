import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("opening Master alone wakes its feeds and returns the ready inverter before a slow source", { timeout: 15000 }, async () => {
  const waiting = []; let slowCalls = 0;
  const frame = { ok: true, data: { solarW: 2300, acOutW: 1400, gridW: -850, gridV: 230 } };
  const source = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/pv9000/")) { slowCalls++; waiting.push(res); return; }
    res.end(JSON.stringify(frame));
  });
  source.listen(0, "127.0.0.1"); await once(source, "listening");
  const base = `http://127.0.0.1:${source.address().port}`;
  const reserve = http.createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      PV14000_NEW_API_BASE: `${base}/pv14000`, PV9000_API_BASE: `${base}/pv9000`,
      MATRIX_API_BASE: `${base}/matrix`, TUYA_API_BASE: `${base}/tuya`,
      PV9000_DASHBOARD_PASSWORD: "", PV14000_NEW_DASHBOARD_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume(); child.stderr.resume();
  try {
    let available = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const res = await fetch(`http://127.0.0.1:${port}/api/master/wake`); available = res.ok; if (available) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(available, true, "database connection must not block the HTTP listener");
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/master/live`);
    const partial = await response.json();
    assert.ok(Date.now() - started < 3000, "live API must not await the slow source's cold-start timeout");
    assert.equal(partial.systems.pv14000.solarW, 2300);
    assert.equal(partial.sources.pv9000.state, "connecting");
    assert.equal(partial.startupMode, "automatic-parallel");
    assert.equal(slowCalls, 1);
    for (const res of waiting.splice(0)) res.end(JSON.stringify(frame));
    let recovered;
    for (let attempt = 0; attempt < 15; attempt++) {
      recovered = await (await fetch(`http://127.0.0.1:${port}/api/master/live`)).json();
      if (recovered.systems.pv9000) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(recovered.systems.pv9000.solarW, 2300);
    assert.equal(recovered.sources.pv9000.ready, true);
  } finally {
    child.kill("SIGTERM"); await once(child, "exit");
    source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
  }
});
