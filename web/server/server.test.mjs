// End-to-end test for the Node host — run with `npm test`.
//
// proxy.test.mjs proves the proxy's logic against in-memory stubs. This proves
// the *host*: that the real lyric cache (memory in front of disk) satisfies what
// proxy.mjs asks of it, over real HTTP, across a restart, and through an
// outbound SOCKS5 proxy.
//
//   node server.test.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
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
const KEY = "sl_sk_server_test";
const upstream = { calls: [], auth: [] };
const api = http.createServer(async (req, res) => {
  const id = req.url.split("/").pop();
  upstream.calls.push(id);
  upstream.auth.push(req.headers.authorization);
  await new Promise((r) => setTimeout(r, 40)); // make coalescing observable
  res.writeHead(200, { "Content-Type": "application/json", "RateLimit-Remaining": "59" });
  res.end(JSON.stringify({ Body: { id, source: "spicy_lyrics", Type: "Syllable", Content: [1, 2, 3] }, Status: 200, Type: "object" }));
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
      SPICY_API_KEY: KEY,
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

const TRACK = "4cOdK2wGLETKBW3PvgPWqT";
const q = (id) => fetch(`${BASE}/v1/lyrics/${id}`, { headers: { Origin: "https://page.test" } });

// A cache left by the pre-v1 proxy: same directory scheme, `/query` bodies.
const LEGACY_DIR = path.join(STATE, "lyrics-cache");
fs.mkdirSync(LEGACY_DIR, { recursive: true });
const legacyFile = path.join(LEGACY_DIR, crypto.createHash("sha256").update(TRACK).digest("hex") + ".json");
fs.writeFileSync(legacyFile, JSON.stringify({
  expires: Date.now() + 3600e3,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify({ queries: [{ operationId: "0", result: { httpStatus: 200 } }] })).toString("base64"),
}));

let host = startHost();
await waitReady();

check("the pre-v1 cache is removed at startup", !fs.existsSync(LEGACY_DIR));

// 1. Concurrent identical lyric lookups share one upstream call, with the key.
const burst = await Promise.all([0, 1, 2, 3].map(() => q(TRACK)));
check("4 simultaneous lookups → 1 upstream call", upstream.calls.length === 1, `got ${upstream.calls.length}`);
check("all four served", burst.every((r) => r.status === 200));
check("the key reached the API as a bearer", upstream.auth[0] === `Bearer ${KEY}`);

// 2. The disk-backed cache works.
upstream.calls.length = 0;
const second = await q(TRACK);
check("repeat lookup → cache hit", second.headers.get("X-Spicy-Cache") === "hit", second.headers.get("X-Spicy-Cache"));
check("repeat lookup → 0 upstream", upstream.calls.length === 0);
check("cached body is the real one", (await second.json()).Body.Type === "Syllable");

// 3. The lyric cache survives a restart.
host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 600));
host = startHost();
await waitReady();

upstream.calls.length = 0;
const afterRestart = await q(TRACK);
check("lyric cache survives a restart (served from disk)",
  afterRestart.headers.get("X-Spicy-Cache") === "hit",
  afterRestart.headers.get("X-Spicy-Cache"));
check("and still costs nothing upstream", upstream.calls.length === 0);

const stats = await (await fetch(`${BASE}/__spicy/stats`)).json();
check("stats see the key, not its value", stats.keyKind === "secret" && !JSON.stringify(stats).includes(KEY));
check("no upstream block seen against a normal host", stats.upstreamBlocked === null);

// 5. The whole host works through an outbound SOCKS5 proxy, and really uses it.
host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 600));

const socks = startSocks5();
await socks.listen();
host = startHost({ PROXY_URL: `socks5://127.0.0.1:${socks.server.address().port}` });
await waitReady();

upstream.calls.length = 0;
const proxied = await q("3n3Ppam7vgaVa1iaRUc9Lp");
check("PROXY_URL: lyrics still resolve", proxied.status === 200);
check("PROXY_URL: the upstream call reached the API", upstream.calls.includes("3n3Ppam7vgaVa1iaRUc9Lp"));
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
