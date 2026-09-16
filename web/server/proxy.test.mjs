// Offline smoke test for proxy.mjs — run with `npm test` (needs Node 20+).
//
// It stubs the network and hands the proxy an in-memory cache and store, then
// asserts the property the proxy exists for: N devices are one client from
// api.spicylyrics.org's point of view.
//
//   node proxy.test.mjs
import { createProxy } from "./proxy.mjs";

// --- fake network ----------------------------------------------------------
const upstream = { calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url);
  if (u.startsWith("https://api.spicylyrics.org")) {
    const body = JSON.parse(init.body);
    const op = body.queries[0].operation;
    upstream.calls.push(op);
    if (upstream.blockNext) {
      const pages = {
        // The classic "you have been blocked" interstitial...
        block:
          "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>" +
          "<body><h1>Sorry, you have been blocked</h1>Cloudflare Ray ID: deadbeef</body></html>",
        // ...and the managed challenge, which names neither Cloudflare nor a
        // block anywhere near the top. Verbatim shape of what a challenged
        // address really gets back.
        challenge:
          '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
          '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
          '<meta http-equiv="X-UA-Compatible" content="IE=Edge"><meta name="robots" content="noindex">' +
          '</head><body class="no-js"><div class="main-wrapper"><h1>www.example.com</h1>' +
          "<p>Verifying you are human. This may take a few seconds.</p></div></body></html>",
      };
      return new Response(pages[upstream.blockNext] ?? pages.block, {
        status: 403,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
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

// --- host stubs ------------------------------------------------------------
const cached = new Map();
const cache = {
  async match(id) {
    return cached.has(id) ? { buf: cached.get(id), contentType: "application/json" } : undefined;
  },
  async put(id, { buf }) {
    cached.set(id, Buffer.from(buf));
  },
};

let saved;
const store = { async load() { return saved; }, async save(s) { saved = structuredClone(s); } };

const env = { SP_DC: "fake-cookie", LOG_LEVEL: "warn" };
const proxy = createProxy({ env, cache, store });
const hub = proxy.hub;

// The proxy does work after answering (opening the session, writing the cache).
// Nothing reports when that settles, so give it a moment.
const settle = () => new Promise((r) => setTimeout(r, 80));

const post = (body) =>
  proxy.fetch(new Request("https://proxy.test/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://page.test" },
    body: JSON.stringify(body),
  }));

const sessionOp = (operation, variables = {}) => ({ queries: [{ operationId: "0", operation, variables }], client: { version: "6.3.20" } });
const lyricsOp = (id) => ({ queries: [{ operationId: "0", operation: "lyrics", variables: { id, auth: "SpicyLyrics-WebAuth" } }], client: { version: "6.3.20" } });

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
check("exactly one of them is reported as the upstream fetch",
  results.filter((r) => r.headers.get("X-Spicy-Cache") === "miss").length === 1,
  results.map((r) => r.headers.get("X-Spicy-Cache")).join(","));
check("CORS echoed", results[0].headers.get("Access-Control-Allow-Origin") === "https://page.test");

// 3. A later request for the same track is served from the cache.
upstream.calls.length = 0;
const again = await post(lyricsOp("4cOdK2wGLETKBW3PvgPWqT"));
await settle();
check("repeat play → 0 upstream calls", upstream.calls.length === 0, `got ${upstream.calls.length}`);
check("served from cache", again.headers.get("X-Spicy-Cache") === "hit", again.headers.get("X-Spicy-Cache"));

// 4. Keep-alive is armed and driven by the hub's own timer, not by clients.
check("keep-alive armed", hub.s.alarmAt !== null && hub.s.alarmAt > Date.now());
upstream.calls.length = 0;
await hub.alarm();
check("one alarm → one upstream ping", upstream.calls.join(",") === "ping", upstream.calls.join(","));
check("and the next one is scheduled", hub.s.alarmAt > Date.now());

// 5. Stats endpoint.
const stats = await (await proxy.fetch(new Request("https://proxy.test/__spicy/stats"))).json();
check("stats report the shared session open", stats.sessionOpen === true);
check("stats show client ops >> upstream traffic",
  stats.stats.clientOps >= 12 && stats.stats.lyricsUpstream === 1,
  `clientOps=${stats.stats.clientOps} lyricsUpstream=${stats.stats.lyricsUpstream}`);

// 6. State survives a restart: a fresh hub picks up the saved session.
{
  const revived = createProxy({ env, cache, store });
  await revived.hub.ready;
  check("a restarted proxy reuses the saved session", revived.hub.s.tk === hub.s.tk);
  check("and re-arms its keep-alive without pinging", revived.hub.s.alarmAt !== null);
  revived.hub.stop();
}

// 7. An upstream Cloudflare block page is named as such, not passed through as
//    HTML and not cached.
{
  upstream.blockNext = "block";
  upstream.calls.length = 0;
  const r = await post(lyricsOp("9ZzBlockedTrack"));
  await settle();
  check("upstream block → 403 to the page", r.status === 403);
  check("upstream block flagged in a header", r.headers.get("X-Spicy-Upstream") === "blocked");
  const j = await r.clone().json();
  check("upstream block returns JSON, never the Cloudflare HTML", j.error === "upstream-blocked");
  const stats2 = await (await proxy.fetch(new Request("https://proxy.test/__spicy/stats"))).json();
  check("upstream block counted in stats", stats2.upstreamBlocked?.count >= 1);

  upstream.blockNext = null;
  upstream.calls.length = 0;
  const retry = await post(lyricsOp("9ZzBlockedTrack"));
  await settle();
  check("a block is never cached — the next try goes upstream again",
    upstream.calls.filter((c) => c === "lyrics").length === 1);
  check("and then succeeds", (await retry.json()).queries[0].result.data.Type === "Syllable");
}

// 8. The managed-challenge page ("Just a moment...") is a block too. It carries
//    none of the words the old detector looked for, so it used to sail through
//    as raw HTML into the page's JSON parser.
{
  upstream.blockNext = "challenge";
  upstream.calls.length = 0;
  const r = await post(lyricsOp("8ChallengedTrack"));
  await settle();
  const body = await r.clone().text();
  check("challenge page → 403, not passed through", r.status === 403);
  check("challenge page flagged as blocked", r.headers.get("X-Spicy-Upstream") === "blocked");
  check("challenge page never reaches the client as HTML",
    !body.includes("Just a moment") && JSON.parse(body).error === "upstream-blocked",
    body.slice(0, 60));
  const st = await (await proxy.fetch(new Request("https://proxy.test/__spicy/stats"))).json();
  check("stats name it a challenge, so the operator knows to change exit path",
    st.upstreamBlocked?.kind === "cloudflare-challenge", String(st.upstreamBlocked?.kind));

  upstream.blockNext = null;
  upstream.calls.length = 0;
  const retry = await post(lyricsOp("8ChallengedTrack"));
  await settle();
  check("a challenge is never cached either",
    upstream.calls.filter((c) => c === "lyrics").length === 1);
  check("and then succeeds", (await retry.json()).queries[0].result.data.Type === "Syllable");
}

hub.stop();
globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
