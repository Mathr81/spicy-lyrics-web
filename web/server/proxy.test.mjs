// Offline tests for proxy.mjs — run with `npm test`.
//
// Stubs the upstream API with a fake `fetch` and the cache with a Map, then
// checks what the proxy promises: the key is added and never leaked, lookups
// are cached and coalesced, and an exhausted rate-limit window is respected.
//
//   node proxy.test.mjs

import { createProxy } from "./proxy.mjs";

const KEY = "sl_sk_test_key_never_leaked";
const A = "4cOdK2wGLETKBW3PvgPWqT";
const B = "0VjIjW4GlUZAMYd2vXMi3b";
const MISSING = "0000000000000000000000";
const LIMITED = "1111111111111111111111";

const lyricsBody = (id) => ({
  Body: { id, source: "apple_music", Type: "Syllable", Content: [] },
  Status: 200,
  Type: "object",
});
const errBody = (status, error) => ({ Body: { error, message: error }, Status: status, Type: "object" });

const upstream = { calls: [], auth: [], rateLimitNext: false, html: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const id = new URL(url).pathname.split("/").pop();
  upstream.calls.push(id);
  upstream.auth.push(new Headers(init?.headers).get("Authorization"));
  await new Promise((r) => setTimeout(r, 20)); // make coalescing observable
  const rate = { "RateLimit-Limit": "60", "RateLimit-Remaining": "42", "RateLimit-Reset": "30" };
  if (upstream.html) {
    return new Response("<html>Just a moment...</html>", { status: 403, headers: { "Content-Type": "text/html" } });
  }
  if (upstream.rateLimitNext) {
    upstream.rateLimitNext = false;
    return new Response(JSON.stringify(errBody(429, "rate_limited")), {
      status: 429,
      headers: { "Content-Type": "application/json", ...rate, "RateLimit-Remaining": "0", "Retry-After": "30" },
    });
  }
  if (id === MISSING) {
    return new Response(JSON.stringify(errBody(404, "lyrics_not_found")), {
      status: 404,
      headers: { "Content-Type": "application/json", ...rate },
    });
  }
  if (id === LIMITED) {
    return new Response(JSON.stringify(errBody(429, "upstream_rate_limited")), {
      status: 429,
      headers: { "Content-Type": "application/json", ...rate },
    });
  }
  return new Response(JSON.stringify(lyricsBody(id)), {
    status: 200,
    headers: { "Content-Type": "application/json", ...rate },
  });
};

const store = new Map();
const cache = {
  async match(id) {
    return store.get(id);
  },
  async put(id, entry) {
    store.set(id, entry);
  },
};

let proxy = createProxy({ env: { SPICY_API_KEY: KEY, LOG_LEVEL: "silent" }, cache });
const get = (path, init) =>
  proxy.fetch(new Request(`http://proxy.test${path}`, { headers: { Origin: "https://page.test" }, ...init }));

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

// 1. A lookup goes upstream with the key, and comes back with CORS.
{
  const r = await get(`/v1/lyrics/${A}`);
  const body = await r.json();
  check("lyrics served", r.status === 200 && body.Body.Type === "Syllable", `status ${r.status}`);
  check("upstream got the key as a bearer", upstream.auth[0] === `Bearer ${KEY}`);
  check("CORS for the page's origin", r.headers.get("Access-Control-Allow-Origin") === "https://page.test");
  check("rate-limit headers passed through", r.headers.get("RateLimit-Remaining") === "42");
}

// 2. Four devices, same song, same moment → one upstream call.
{
  upstream.calls.length = 0;
  const burst = await Promise.all([0, 1, 2, 3].map(() => get(`/v1/lyrics/${B}`)));
  check("4 simultaneous lookups → 1 upstream call", upstream.calls.length === 1, `got ${upstream.calls.length}`);
  check("all four served", burst.every((r) => r.status === 200));
}

// 3. Cached: found lyrics and a definite miss.
{
  upstream.calls.length = 0;
  const again = await get(`/v1/lyrics/${A}`);
  check("repeat lookup → cache hit", again.headers.get("X-Spicy-Cache") === "hit");
  check("repeat lookup → 0 upstream", upstream.calls.length === 0);

  const miss1 = await get(`/v1/lyrics/${MISSING}`);
  const miss2 = await get(`/v1/lyrics/${MISSING}`);
  check("no lyrics → 404 passed through", miss1.status === 404 && (await miss1.json()).Body.error === "lyrics_not_found");
  check("…and cached as a 404", miss2.status === 404 && miss2.headers.get("X-Spicy-Cache") === "hit");
  check("…costing one upstream call", upstream.calls.length === 1, `got ${upstream.calls.length}`);
}

// 4. A per-track upstream throttle is not cached and does not stop the proxy.
{
  upstream.calls.length = 0;
  const t1 = await get(`/v1/lyrics/${LIMITED}`);
  const t2 = await get(`/v1/lyrics/${LIMITED}`);
  check("upstream_rate_limited passed through", t1.status === 429);
  check("…never cached, never a cooldown", t2.status === 429 && upstream.calls.length === 2, `calls ${upstream.calls.length}`);
}

// 5. Malformed id and unknown path cost nothing upstream.
{
  upstream.calls.length = 0;
  const bad = await get("/v1/lyrics/not-a-track");
  check("malformed id → 400 invalid_track_id", bad.status === 400 && (await bad.json()).Body.error === "invalid_track_id");
  const other = await get("/query", { method: "POST", body: "{}" });
  check("the old /query endpoint is gone", other.status === 404);
  check("…neither reached the API", upstream.calls.length === 0);
}

// 6. The application's window is exhausted: stop forwarding until it resets.
{
  upstream.calls.length = 0;
  upstream.rateLimitNext = true;
  const first = await get("/v1/lyrics/2222222222222222222222");
  check("rate_limited passed through", first.status === 429 && first.headers.get("Retry-After") === "30");
  const second = await get("/v1/lyrics/3333333333333333333333");
  check("next lookup answered locally", second.status === 429 && second.headers.get("X-Spicy-Cache") === "cooldown");
  check("…without touching the API", upstream.calls.length === 1, `calls ${upstream.calls.length}`);
  const cached = await get(`/v1/lyrics/${A}`);
  check("cache hits still served during the cooldown", cached.status === 200);
  const s = proxy.stats();
  check("stats report the cooldown", s.rateLimit.coolingDownForSeconds > 0 && s.stats.rateLimited === 1);
}

// 7. The key never leaves the proxy.
{
  const s = await (await get("/__spicy/stats")).text();
  check("stats name the key kind", JSON.parse(s).keyKind === "secret");
  check("stats never contain the key", !s.includes(KEY));
}

// 8. A Cloudflare page instead of the API is named, not parsed or cached.
{
  proxy = createProxy({ env: { SPICY_API_KEY: KEY, LOG_LEVEL: "silent" }, cache });
  upstream.html = true;
  const r = await get("/v1/lyrics/4444444444444444444444");
  check("HTML answer → 502 X-Spicy-Upstream: blocked", r.status === 502 && r.headers.get("X-Spicy-Upstream") === "blocked");
  check("…with a JSON error body", (await r.json()).Body.error === "upstream_blocked");
  check("…and not cached", !store.has("4444444444444444444444"));
  check("stats name the kind of wall", proxy.stats().upstreamBlocked?.kind === "cloudflare-challenge", proxy.stats().upstreamBlocked?.kind);
  upstream.html = false;
}

// 9. Without a key the proxy says so rather than calling the API anonymously.
{
  proxy = createProxy({ env: { LOG_LEVEL: "silent" }, cache });
  upstream.calls.length = 0;
  const r = await get("/v1/lyrics/5555555555555555555555");
  check("no key → 500 proxy_not_configured", r.status === 500 && (await r.json()).Body.error === "proxy_not_configured");
  check("…without an upstream call", upstream.calls.length === 0);
}

globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
