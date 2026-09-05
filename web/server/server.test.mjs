// End-to-end test for the standalone Node host — run with `npm test`.
//
// worker.test.mjs proves the proxy's logic with hand-written stubs. This proves
// the *host*: that the real server.mjs shims (caches.default backed by
// memory+disk, Durable Object storage backed by a JSON file, alarms backed by
// timers) actually satisfy what worker.js asks of them, over real HTTP.
//
//   node server.test.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startSocks5 } from "./proxy-servers.test-helper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "slproxy-"));

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

// --- stub API --------------------------------------------------------------
const upstream = { calls: [] };
const api = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const op = JSON.parse(raw).queries[0].operation;
    upstream.calls.push(op);
    await new Promise((r) => setTimeout(r, 40)); // make coalescing observable
    const data =
      op === "createSession" || op === "refreshSession"
        ? { tk: "UPSTREAM-TOKEN" }
        : op === "lyrics"
          ? { Type: "Syllable", Content: [1, 2, 3] }
          : { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        queries: [{ operationId: "0", operation: op, result: { httpStatus: 200, data } }],
      })
    );
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API_ORIGIN = `http://127.0.0.1:${api.address().port}`;

// --- host under test -------------------------------------------------------
// Take whatever port the OS hands out rather than a fixed one: a leftover
// process from an earlier run must not turn into a confusing EADDRINUSE.
const PORT = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;

function startHost(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: {
      ...process.env,
      // The machine running the tests may well have proxy variables set for
      // unrelated reasons; each scenario states its own.
      PROXY_URL: "",
      ALL_PROXY: "",
      all_proxy: "",
      ...extraEnv,
      PORT: String(PORT),
      STATE_DIR: STATE,
      API_ORIGIN,
      LOG_LEVEL: "silent",
      // No SP_DC on purpose: the stub API authorises nothing, and minting a real
      // web-player token would mean reaching out to open.spotify.com from a test.
      SP_DC: "",
      DISABLE_SECRET_FETCH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return child;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/__spicy/stats`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("host did not start");
}

const q = (body) =>
  fetch(`${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://page.test" },
    body: JSON.stringify(body),
  });
const sessionOp = (operation) => ({ queries: [{ operationId: "0", operation, variables: {} }] });
const lyricsOp = (id) => ({
  queries: [{ operationId: "0", operation: "lyrics", variables: { id, auth: "SpicyLyrics-WebAuth" } }],
  client: { version: "6.3.12" },
});

let host = startHost();
await waitReady();

// 1. Session ops are answered by the host, not forwarded.
upstream.calls.length = 0;
for (let d = 0; d < 4; d++) {
  await q(sessionOp("pingConfig"));
  await q(sessionOp("createSession"));
  await q(sessionOp("ping"));
}
await new Promise((r) => setTimeout(r, 700));
check("4 devices → 1 upstream createSession",
  upstream.calls.filter((c) => c === "createSession").length === 1,
  upstream.calls.join(","));
check("client pings never leave the host", upstream.calls.filter((c) => c === "ping").length === 0);

// 2. Concurrent identical lyric lookups share one upstream call.
upstream.calls.length = 0;
const burst = await Promise.all([0, 1, 2, 3].map(() => q(lyricsOp("TrackAAA"))));
check("4 simultaneous lookups → 1 upstream lyrics call",
  upstream.calls.filter((c) => c === "lyrics").length === 1,
  `got ${upstream.calls.filter((c) => c === "lyrics").length}`);
check("all four served", burst.every((r) => r.status === 200));

// 3. The disk-backed cache shim works.
upstream.calls.length = 0;
const second = await q(lyricsOp("TrackAAA"));
check("repeat lookup → cache hit", second.headers.get("X-Spicy-Cache") === "hit",
  second.headers.get("X-Spicy-Cache"));
check("repeat lookup → 0 upstream", upstream.calls.length === 0);
check("cached body is the real one",
  (await second.json()).queries[0].result.data.Type === "Syllable");

// 4. State survives a restart: both the lyric cache and the shared session.
host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 600));
host = startHost();
await waitReady();

upstream.calls.length = 0;
const afterRestart = await q(lyricsOp("TrackAAA"));
check("lyric cache survives a restart (served from disk)",
  afterRestart.headers.get("X-Spicy-Cache") === "hit",
  afterRestart.headers.get("X-Spicy-Cache"));
check("and still costs nothing upstream", upstream.calls.length === 0);

const stats = await (await fetch(`${BASE}/__spicy/stats`)).json();
check("shared session survived the restart — no second createSession",
  stats.sessionOpen === true && upstream.calls.filter((c) => c === "createSession").length === 0,
  `sessionOpen=${stats.sessionOpen}`);
check("stats show the gap between asked and forwarded",
  stats.stats.clientOps >= 12 && stats.stats.createSession === 1,
  `clientOps=${stats.stats.clientOps} createSession=${stats.stats.createSession}`);
check("no upstream block seen against a normal host", stats.upstreamBlocked === null);

// 5. The whole host works through an outbound SOCKS5 proxy, and really uses it.
host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 600));

const socks = startSocks5();
await socks.listen();
host = startHost({ PROXY_URL: `socks5://127.0.0.1:${socks.server.address().port}` });
await waitReady();

upstream.calls.length = 0;
const proxied = await q(lyricsOp("TrackViaProxy"));
check("PROXY_URL: lyrics still resolve", proxied.status === 200);
check("PROXY_URL: the upstream call reached the API", upstream.calls.includes("lyrics"));
check("PROXY_URL: and it went through the SOCKS5 proxy, not direct",
  socks.state.targets.some((t) => t.endsWith(`:${api.address().port}`)),
  socks.state.targets.join(",") || "(nothing brokered)");

host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
socks.server.close();
api.close();
fs.rmSync(STATE, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
