// Independent source requests: a sleeping service must not hold up a ready one.
export function sourceIssue(error) {
  if (error?.status === 429) return "rate_limited";
  if (error?.status === 401 || error?.status === 403) return "authentication";
  if (error?.code === "NOT_CONFIGURED") return "not_configured";
  if (error?.code === "UPSTREAM_NOT_READY" || error?.name === "AbortError" || error?.name === "TimeoutError") return "connecting";
  return "unavailable";
}

export function createLiveSources(definitions, { now = Date.now } = {}) {
  const states = Object.fromEntries(Object.entries(definitions).map(([key]) => [key, {
    value: null, error: null, inFlight: null, finishedAt: 0, nextAt: 0, attempts: 0
  }]));

  function refresh() {
    for (const [key, config] of Object.entries(definitions)) {
      const state = states[key];
      if (!config.configured || state.inFlight || now() < state.nextAt) continue;
      state.attempts++;
      const startedAt = now();
      state.error = null;
      state.inFlight = Promise.resolve().then(config.read).then(value => {
        if (!value || typeof value !== "object") throw new Error("Source returned no telemetry");
        state.value = value;
        state.finishedAt = now();
        state.nextAt = startedAt + (config.intervalMs ?? 4500);
      }).catch(error => {
        state.value = null;
        state.error = error;
        const issue = sourceIssue(error);
        const delay = issue === "rate_limited" ? Math.max(1000, error.retryAfterMs || 30000)
          : issue === "authentication" || issue === "not_configured" ? 60000 : 5000;
        state.nextAt = now() + delay;
      }).finally(() => { state.inFlight = null; });
    }
  }

  function snapshot() {
    const results = {}, sources = {};
    for (const [key, config] of Object.entries(definitions)) {
      const state = states[key];
      const valid = state.value && now() - state.finishedAt <= (config.freshForMs ?? 15000);
      const status = !config.configured ? "not_configured" : valid ? "ready"
        : state.inFlight ? "connecting" : state.error ? sourceIssue(state.error) : "connecting";
      sources[key] = {
        state: status, configured: Boolean(config.configured), ready: Boolean(valid),
        attempts: state.attempts, updatedAt: state.value?.updatedAt || 0,
        retryInSeconds: state.inFlight ? 0 : Math.max(0, Math.ceil((state.nextAt - now()) / 1000))
      };
      if (!config.configured) results[key] = { status: "fulfilled", value: null };
      else if (valid) results[key] = { status: "fulfilled", value: state.value };
      else {
        const connecting = new Error(`Connecting to ${key} data service; automatic retry is active`);
        connecting.code = "UPSTREAM_NOT_READY";
        results[key] = { status: "rejected", reason: state.error || connecting };
      }
    }
    return { results, sources, warmingUp: Object.values(sources).some(source => source.configured && source.state === "connecting") };
  }

  async function sample({ waitMs = 1200 } = {}) {
    refresh();
    const pending = Object.values(states).map(state => state.inFlight).filter(Boolean);
    if (pending.length && waitMs > 0) {
      let timer;
      try {
        await Promise.race([Promise.all(pending), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      } finally { clearTimeout(timer); }
    }
    return snapshot();
  }

  return { refresh, snapshot, sample };
}
