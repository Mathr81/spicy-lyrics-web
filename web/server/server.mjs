#!/usr/bin/env node
// Standalone host for the Spicy Lyrics proxy — runs `../proxy/worker.js`
// unmodified on plain Node (a VPS, a home server, a container).
//
// Why this exists: api.spicylyrics.org's WAF refuses requests coming from
// Cloudflare Workers (a byte-identical POST returns 200 from an ordinary
// address and a Cloudflare block page from a Worker). Running the same proxy
// from a normal machine puts the requests back on a normal network path.
//
// Why it imports the Worker instead of reimplementing it: the interesting parts
// — the TOTP web-player token minting, the single shared API session, the
// request coalescing — are exactly the parts that must not drift between two
// copies. Node 20 already provides fetch/Request/Response/crypto.subtle, so the
// only things missing are `caches` and the Durable Object runtime. This file is
// those two shims plus an HTTP server; the proxy logic lives in one place.
//
//   node server.mjs                 # listens on $PORT (default 8787)
//
// Configuration is the same names as the Worker's wrangler `[vars]`, read from
// the environment:
//
//   SP_DC                    required for synced lyrics (your Spotify cookie)
//   PORT                     default 8787
//   STATE_DIR                default ./.state — session + lyric cache on disk
//   LOG_LEVEL                debug | info | warn | error | silent
//   CLIENT_VERSION, LYRICS_CACHE_TTL, LYRICS_MISS_CACHE_TTL,
//   CLIENT_PING_INTERVAL_MS, CLIENT_SESSION_TTL_S, SESSION_IDLE_MS
//
// Serve it over HTTPS (a reverse proxy such as Caddy, or a Cloudflare Tunnel) if
// the page itself is on HTTPS — browsers block mixed content, and the Screen
// Wake Lock API needs a secure context.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "..", "proxy", "worker.js");
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HERE, ".state"));
const CACHE_DIR = path.join(STATE_DIR, "lyrics-cache");
const STATE_FILE = path.join(STATE_DIR, "session.json");
const PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- `caches.default` ------------------------------------------------------
// The Worker stores lyric bodies keyed by a synthetic URL, with a max-age. Same
// contract here, backed by memory + disk so a restart doesn't re-query the API
// for every song you've already played.

const MEM_CACHE_MAX = 500;
const mem = new Map(); // key -> { expires, contentType, body: Buffer }

const cacheFile = (key) =>
  path.join(CACHE_DIR, crypto.createHash("sha256").update(key).digest("hex") + ".json");

function memSet(key, entry) {
  mem.set(key, entry);
  if (mem.size > MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
}

const cacheShim = {
  async match(request) {
    const key = typeof request === "string" ? request : request.url;
    let entry = mem.get(key);
    if (!entry) {
      try {
        const raw = JSON.parse(await fsp.readFile(cacheFile(key), "utf8"));
        entry = {
          expires: raw.expires,
          contentType: raw.contentType,
          body: Buffer.from(raw.body, "base64"),
        };
        memSet(key, entry);
      } catch {
        return undefined;
      }
    }
    if (Date.now() > entry.expires) {
      mem.delete(key);
      fsp.rm(cacheFile(key), { force: true }).catch(() => {});
      return undefined;
    }
    return new Response(entry.body, { headers: { "Content-Type": entry.contentType } });
  },

  async put(request, response) {
    const key = typeof request === "string" ? request : request.url;
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control") || "")?.[1] ?? 0);
    if (!maxAge) return;
    const contentType = response.headers.get("Content-Type") || "application/json";
    const body = Buffer.from(await response.arrayBuffer());
    const entry = { expires: Date.now() + maxAge * 1000, contentType, body };
    memSet(key, entry);
    await fsp
      .writeFile(
        cacheFile(key),
        JSON.stringify({ expires: entry.expires, contentType, body: body.toString("base64") })
      )
      .catch(() => {});
  },
};

globalThis.caches = { default: cacheShim };

// --- Durable Object runtime ------------------------------------------------
// One process means one instance, which is the guarantee the Durable Object was
// there to provide in the first place. Storage is a JSON file so the shared
// session and its counters survive a restart; the alarm is a timer.

const workerModule = await import(pathToFileURL(WORKER).href);
const { SpicySession } = workerModule;
const worker = workerModule.default;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

const persisted = loadState();
let alarmTimer = null;
let alarmAt = persisted.__alarmAt ?? null;
let writeQueued = false;

const storage = new Map(Object.entries(persisted.data || {}));

function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    const out = { __alarmAt: alarmAt, data: Object.fromEntries(storage) };
    fsp.writeFile(STATE_FILE, JSON.stringify(out)).catch(() => {});
  }, 200).unref?.();
}

function armAlarm() {
  if (alarmTimer) clearTimeout(alarmTimer);
  alarmTimer = null;
  if (alarmAt === null) return;
  const delay = Math.max(0, alarmAt - Date.now());
  alarmTimer = setTimeout(() => {
    alarmAt = null;
    persist();
    instance.alarm().catch((err) => log("alarm failed", err));
  }, delay);
  alarmTimer.unref?.();
}

const doState = {
  storage: {
    get: async (k) => storage.get(k),
    put: async (k, v) => {
      storage.set(k, v);
      persist();
    },
    delete: async (k) => {
      storage.delete(k);
      persist();
    },
    getAlarm: async () => alarmAt,
    setAlarm: async (t) => {
      alarmAt = t;
      persist();
      armAlarm();
    },
    deleteAlarm: async () => {
      alarmAt = null;
      persist();
      armAlarm();
    },
  },
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil: (p) => Promise.resolve(p).catch(() => {}),
};

const env = { ...process.env };
const instance = new SpicySession(doState, env);

// The Worker reaches its hub through `env.SESSION`; in-process that is a direct
// call to the one instance.
env.SESSION = {
  idFromName: (name) => name,
  get: () => ({ fetch: (url, init) => instance.fetch(new Request(url, init)) }),
};

const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

armAlarm();

// --- HTTP server -----------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Hop-by-hop headers describe this connection, not the request; forwarding them
// into a `Request` is meaningless and undici rejects some outright.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function toHeaders(nodeHeaders) {
  const h = new Headers();
  for (const [k, v] of Object.entries(nodeHeaders)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const body = await readBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: toHeaders(req.headers),
      body: body && body.length ? body : undefined,
    });

    const out = await worker.fetch(request, env, ctx);
    const headers = Object.fromEntries(out.headers);
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    log("request failed", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy-failure" }));
  }
});

server.listen(PORT, () => {
  log(`spicy-lyrics proxy listening on http://0.0.0.0:${PORT}`);
  log(`state: ${STATE_DIR}`);
  if (!process.env.SP_DC) {
    log("WARNING: SP_DC is not set — synced lyrics will be unavailable (text only).");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    server.close(() => process.exit(0));
  });
}
