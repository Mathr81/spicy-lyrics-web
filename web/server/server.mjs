#!/usr/bin/env node
// HTTP host for the Spicy Lyrics proxy — a VPS, a home server, a container.
//
// `proxy.mjs` holds the logic (CORS, the minted web-player token, the single
// shared API session, coalescing). This file is the parts that touch the
// machine: an HTTP server, a lyric cache on disk, and the hub's state in a JSON
// file. One process is one hub, so "every device is one client to the API" is a
// property of running it, not something to configure.
//
//   node server.mjs                 # listens on $PORT (default 8787)
//
// Configuration, all from the environment:
//
//   SP_DC                    required for synced lyrics (your Spotify cookie)
//   PORT                     default 8787
//   STATE_DIR                default ./.state — session + lyric cache on disk
//   PROXY_URL                send the proxy's OWN outbound requests through
//                            another proxy, e.g. socks5://127.0.0.1:1080
//                            (also read from ALL_PROXY)
//   LOG_LEVEL                debug | info | warn | error | silent
//   API_ORIGIN               upstream base URL (default https://api.spicylyrics.org)
//   CLIENT_VERSION, LYRICS_CACHE_TTL, LYRICS_MISS_CACHE_TTL,
//   CLIENT_PING_INTERVAL_MS, CLIENT_SESSION_TTL_S, SESSION_IDLE_MS
//
// Serve it over HTTPS (a reverse proxy such as Caddy in front) if the page
// itself is on HTTPS — browsers block mixed content, and the Screen Wake Lock
// API needs a secure context.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { installProxyFetch, parseProxyUrl } from "./outbound.mjs";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HERE, ".state"));
const CACHE_DIR = path.join(STATE_DIR, "lyrics-cache");
const STATE_FILE = path.join(STATE_DIR, "session.json");
const PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- outbound proxy --------------------------------------------------------
// Optional: route everything this process sends (the lyrics API and Spotify's
// token endpoints alike) through a SOCKS5 or HTTP CONNECT proxy. Installed
// before proxy.mjs is imported so no outbound call can take the direct path.
// Deliberately NOT read from HTTPS_PROXY / HTTP_PROXY. Those are commonly set
// on a machine for unrelated reasons (apt, curl, a corporate setup), and picking
// them up silently would reroute this process's traffic — Spotify tokens
// included — somewhere the operator never chose. Proxying here is opt-in:
// `PROXY_URL`, or `ALL_PROXY`, whose whole meaning is "proxy everything".
// If HTTPS_PROXY is what you want, say so: PROXY_URL="$HTTPS_PROXY".
const PROXY_VARS = ["PROXY_URL", "ALL_PROXY", "all_proxy"];
const proxyVar = PROXY_VARS.find((name) => process.env[name]);

let outboundProxy = null;
if (proxyVar) {
  outboundProxy = parseProxyUrl(process.env[proxyVar]);
  installProxyFetch(outboundProxy, () => {});
}

const { createProxy } = await import("./proxy.mjs");

// --- lyric cache -----------------------------------------------------------
// Memory in front of disk, so a restart doesn't re-query the API for every song
// you have already played. Lyrics don't change, so the only expiry is the TTL
// the proxy asks for.

const MEM_CACHE_MAX = 500;
const mem = new Map(); // id -> { expires, contentType, body: Buffer }

const cacheFile = (id) =>
  path.join(CACHE_DIR, crypto.createHash("sha256").update(id).digest("hex") + ".json");

function memSet(id, entry) {
  mem.set(id, entry);
  if (mem.size > MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
}

const cache = {
  async match(id) {
    let entry = mem.get(id);
    if (!entry) {
      try {
        const raw = JSON.parse(await fsp.readFile(cacheFile(id), "utf8"));
        entry = {
          expires: raw.expires,
          contentType: raw.contentType,
          body: Buffer.from(raw.body, "base64"),
        };
        memSet(id, entry);
      } catch {
        return undefined;
      }
    }
    if (Date.now() > entry.expires) {
      mem.delete(id);
      fsp.rm(cacheFile(id), { force: true }).catch(() => {});
      return undefined;
    }
    return { buf: entry.body, contentType: entry.contentType };
  },

  async put(id, { buf, contentType, ttl }) {
    if (!ttl) return;
    const body = Buffer.from(buf);
    const entry = {
      expires: Date.now() + ttl * 1000,
      contentType: contentType || "application/json",
      body,
    };
    memSet(id, entry);
    await fsp
      .writeFile(
        cacheFile(id),
        JSON.stringify({
          expires: entry.expires,
          contentType: entry.contentType,
          body: body.toString("base64"),
        })
      )
      .catch(() => {});
  },
};

// --- hub state -------------------------------------------------------------
// A JSON file, written at most every 200ms: the hub saves on every counter
// bump, and none of it is worth an fsync per lyric lookup.

let writeTimer = null;
let pendingState = null;

const store = {
  async load() {
    try {
      return JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    } catch {
      return undefined;
    }
  },
  async save(state) {
    pendingState = state;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const out = JSON.stringify(pendingState);
      fsp.writeFile(STATE_FILE, out).catch((err) => log("state write failed", err));
    }, 200);
    writeTimer.unref?.();
  },
};

const proxy = createProxy({ env: process.env, cache, store });

// --- HTTP server -----------------------------------------------------------

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

    const out = await proxy.fetch(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
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
  // Always say where outbound traffic goes — it must never be a surprise.
  log(
    outboundProxy
      ? `outbound proxy: ${outboundProxy.label} (from ${proxyVar})`
      : "outbound proxy: none (direct) — set PROXY_URL to route through one"
  );
  if (!process.env.SP_DC) {
    log("WARNING: SP_DC is not set — synced lyrics will be unavailable (text only).");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    proxy.hub.stop();
    server.close(() => process.exit(0));
  });
}
