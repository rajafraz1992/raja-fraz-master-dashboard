// One request per resource at a time; honor origin-wide HTTP 429 cooldowns.
// A cooldown never returns old data as a fresh reading.
export function rateLimitError(retryAfter, now = Date.now()) {
  const seconds = Number(String(retryAfter ?? "").trim());
  const date = Date.parse(String(retryAfter || ""));
  const delay = retryAfter != null && String(retryAfter).trim() !== "" && Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000) : Number.isFinite(date) ? Math.max(0, date - now) : null;
  const error = new Error("Upstream data service rate limited (HTTP 429)");
  error.status = 429; error.code = "UPSTREAM_RATE_LIMITED"; error.retryAfterMs = delay;
  return error;
}

export function createUpstreamGate({ now = Date.now } = {}) {
  const requests = new Map(), limits = new Map();
  function blocked(until) {
    const error = rateLimitError(null, now());
    error.retryAt = until;
    error.retryAfterMs = Math.max(0, until - now());
    error.message += `; retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds`;
    return error;
  }
  async function run(url, operation, key = url) {
    const origin = new URL(url).origin;
    const state = limits.get(origin);
    if (state && state.until > now()) throw blocked(state.until);
    if (requests.has(key)) return requests.get(key);
    const work = Promise.resolve().then(operation).then(value => {
      if (limits.get(origin)?.until <= now()) limits.delete(origin);
      return value;
    }).catch(error => {
      if (error?.status === 429) {
        const prior = limits.get(origin), failures = (prior?.failures || 0) + 1;
        const delay = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? error.retryAfterMs : Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4));
        const until = Math.max(prior?.until || 0, now() + delay);
        limits.set(origin, { until, failures });
        throw blocked(until);
      }
      throw error;
    }).finally(() => requests.delete(key));
    requests.set(key, work);
    return work;
  }
  return { run };
}
