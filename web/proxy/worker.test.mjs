// Smoke test for worker.js — run with `npm test` (needs Node 18+, no network).
//
// It stubs the Workers platform (fetch, caches.default, a Durable Object
// namespace) and asserts the property the proxy exists for: N devices are one
// client from api.spicylyrics.org's point of view.
//
//   node worker.test.mjs
import { pathToFileURL } from "node:url";
import path from "node:path";

const WORKER = pathToFileURL(path.join(import.meta.dirname, "worker.js")).href;

// --- fake platform ---------------------------------------------------------
const upstream = { calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url);
  if (u.startsWith("https://api.spicylyrics.org")) {
    const body = JSON.parse(init.body);
    const op = body.queries[0].operation;
    upstream.calls.push(op);
    if (upstream.blockNext) {
      return new Response(
        "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>" +
          "<body><h1>Sorry, you have been blocked</h1>Cloudflare Ray ID: deadbeef</body></html>",
        { status: 403, headers: { "Content-Type": "text/html; charset=UTF-8" } }
      );
    }
    await new Promise((r) => setTimeout(r, 30)); // make coalescing observable
    const data =
      op === "createSession" || op === "refreshSession"
        ? { tk: "REAL-UPSTREAM-TOKEN" }
        : op === "lyrics"
          ? { Type: "Syllable", Content: [1, 2, 3] }
          : { ok: true };
    return new Response(
      JSON.stringify({ queries: [{ operationId: "0", operation: op, result: { httpStatus: 200, data } }] }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  if (u.startsWith("https://open.spotify.com/api/server-time")) {
    return new Response(JSON.stringify({ serverTime: Math.floor(Date.now() / 1000) }));
  }
  if (u.startsWith("https://open.spotify.com/api/token")) {
    return new Response(JSON.stringify({ accessToken: "WEBPLAYER", isAnonymous: false, accessTokenExpirationTimestampMs: Date.now() + 3.6e6 }));
  }
  if (u.startsWith("https://raw.githubusercontent.com")) {
    return new Response("{}", { status: 500 });
  }
  throw new Error("unexpected fetch " + u);
};

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { return store.get(req.url) ? new Response(store.get(req.url), { headers: { "Content-Type": "application/json" } }) : undefined; },
    async put(req, res) { store.set(req.url, Buffer.from(await res.arrayBuffer())); },
  },
};

const worker = (await import(WORKER)).default;

// --- fake Durable Object namespace ----------------------------------------
const { SpicySession } = await import(WORKER);
const storage = new Map();
let alarmAt = null;
const doState = {
  storage: {
    get: async (k) => storage.get(k),
    put: async (k, v) => void storage.set(k, structuredClone(v)),
    getAlarm: async () => alarmAt,
    setAlarm: async (t) => void (alarmAt = t),
    deleteAlarm: async () => void (alarmAt = null),
  },
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil: (p) => pending.push(p),
};
const pending = [];
const env = { SP_DC: "fake-cookie", SESSION: null, LOG_LEVEL: "warn" };
const instance = new SpicySession(doState, env);
env.SESSION = {
  idFromName: () => "shared",
  get: () => ({ fetch: (u, i) => instance.fetch(new Request(u, i)) }),
};

const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.splice(0).map((p) => p); await new Promise((r) => setTimeout(r, 60)); };

const post = (body) =>
  worker.fetch(new Request("https://proxy.test/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://page.test" },
    body: JSON.stringify(body),
  }), env, ctx);

const sessionOp = (operation, variables = {}) => ({ queries: [{ operationId: "0", operation, variables }], client: { version: "6.3.12" } });
const lyricsOp = (id) => ({ queries: [{ operationId: "0", operation: "lyrics", variables: { id, auth: "SpicyLyrics-WebAuth" } }], client: { version: "6.3.12" } });

let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) failed++; };

// 1. Four devices each open a session + read pingConfig + ping.
for (let d = 0; d < 4; d++) {
  const cfgRes = await (await post(sessionOp("pingConfig"))).json();
  const created = await (await post(sessionOp("createSession"))).json();
  const pinged = await (await post(sessionOp("ping", { tk: "x" }))).json();
  if (d === 0) {
    check("pingConfig answered locally, long interval", cfgRes.queries[0].result.data.pingIntervalMs === 900000, JSON.stringify(cfgRes.queries[0].result.data));
    check("createSession returns a proxy-local token, not the upstream one",
      created.queries[0].result.data.tk === "spicy-proxy-shared-session");
    check("ping answered OK", pinged.queries[0].result.httpStatus === 200);
  }
}
await settle();
const sessionCreates = upstream.calls.filter((c) => c === "createSession").length;
const clientPings = upstream.calls.filter((c) => c === "ping").length;
check("4 devices → exactly 1 upstream createSession", sessionCreates === 1, `got ${sessionCreates}`);
check("client pings never reach upstream", clientPings === 0, `got ${clientPings}`);

// 2. Four devices ask for the same track at the same moment.
upstream.calls.length = 0;
const results = await Promise.all([0, 1, 2, 3].map(() => post(lyricsOp("4cOdK2wGLETKBW3PvgPWqT"))));
await settle();
const lyricCalls = upstream.calls.filter((c) => c === "lyrics").length;
check("4 simultaneous devices, same track → 1 upstream lyrics call", lyricCalls === 1, `got ${lyricCalls}`);
check("all four got a 200", results.every((r) => r.status === 200));
check("all four got the lyrics body", (await Promise.all(results.map((r) => r.clone().json()))).every((j) => j.queries[0].result.data.Type === "Syllable"));
check("CORS echoed", results[0].headers.get("Access-Control-Allow-Origin") === "https://page.test");

// 3. A later request for the same track hits the edge cache.
upstream.calls.length = 0;
const again = await post(lyricsOp("4cOdK2wGLETKBW3PvgPWqT"));
await settle();
check("repeat play → 0 upstream calls", upstream.calls.length === 0, `got ${upstream.calls.length}`);
check("served from edge cache", again.headers.get("X-Spicy-Cache") === "hit", again.headers.get("X-Spicy-Cache"));

// 4. Keep-alive is armed and driven by the DO alarm, not by clients.
check("DO alarm armed for keep-alive", alarmAt !== null && alarmAt > Date.now());
upstream.calls.length = 0;
await instance.alarm();
check("one alarm → one upstream ping", upstream.calls.join(",") === "ping", upstream.calls.join(","));

// 5. Stats endpoint.
const stats = await (await worker.fetch(new Request("https://proxy.test/__spicy/stats"), env, ctx)).json();
check("stats report shared session open", stats.sessionOpen === true && stats.mode === "durable-object");
// The three duplicate lyric requests were collapsed by the Worker's own
// in-isolate map before they ever crossed into the DO — so the DO records one
// upstream fetch and zero of its own coalesces. Both layers doing their job.
check("stats show client ops >> upstream traffic",
  stats.stats.clientOps >= 12 && stats.stats.lyricsUpstream === 1,
  `clientOps=${stats.stats.clientOps} lyricsUpstream=${stats.stats.lyricsUpstream}`);

// 6. Same scenario with no Durable Object binding at all (dashboard deploy).
{
  const noDo = { SP_DC: "fake-cookie", LOG_LEVEL: "warn" };
  store.clear();
  upstream.calls.length = 0;
  for (let d = 0; d < 4; d++) {
    await worker.fetch(new Request("https://proxy.test/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionOp("createSession")),
    }), noDo, ctx);
  }
  const rs = await Promise.all([0, 1, 2, 3].map(() =>
    worker.fetch(new Request("https://proxy.test/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lyricsOp("1AbCdEf")),
    }), noDo, ctx)));
  await settle();
  check("fallback (no DO): 4 devices → 1 createSession",
    upstream.calls.filter((c) => c === "createSession").length === 1,
    upstream.calls.join(","));
  check("fallback (no DO): 4 simultaneous lookups → 1 upstream lyrics call",
    upstream.calls.filter((c) => c === "lyrics").length === 1);
  check("fallback (no DO): all four served", rs.every((r) => r.status === 200));
  const fs2 = await (await worker.fetch(new Request("https://proxy.test/__spicy/stats"), noDo, ctx)).json();
  check("fallback reports its weaker mode", fs2.mode === "isolate-fallback");
}

// 7. An upstream Cloudflare block page is named as such, not passed through as
//    HTML and not cached.
{
  upstream.blockNext = true;
  upstream.calls.length = 0;
  const r = await post(lyricsOp("9ZzBlockedTrack"));
  await settle();
  check("upstream block → 403 to the page", r.status === 403);
  check("upstream block flagged in a header", r.headers.get("X-Spicy-Upstream") === "blocked");
  const j = await r.clone().json();
  check("upstream block returns JSON, never the Cloudflare HTML", j.error === "upstream-blocked");
  const stats2 = await (await worker.fetch(new Request("https://proxy.test/__spicy/stats"), env, ctx)).json();
  check("upstream block counted in stats", stats2.upstreamBlocked?.count >= 1);

  upstream.blockNext = false;
  upstream.calls.length = 0;
  const retry = await post(lyricsOp("9ZzBlockedTrack"));
  await settle();
  check("a block is never cached — the next try goes upstream again",
    upstream.calls.filter((c) => c === "lyrics").length === 1);
  check("and then succeeds", (await retry.json()).queries[0].result.data.Type === "Syllable");
}

globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
