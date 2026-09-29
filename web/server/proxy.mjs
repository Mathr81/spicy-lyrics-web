// The Spicy Lyrics proxy — the page's front end for the official Spicy Lyrics
// developer API (`GET https://api.spicylyrics.org/v1/lyrics/{trackId}`).
// Plain Node, no platform runtime.
//
// This module is the logic; `server.mjs` is the HTTP server and the disk that
// back it. Three jobs:
//
// 1. **Hold the key.** The API authenticates with a key sent as
//    `Authorization: Bearer sl_sk_…`. A secret key must never reach a browser,
//    and the API sends no CORS headers for one anyway, so the page cannot call
//    it directly. The page asks this proxy instead; the proxy adds the key
//    (`SPICY_API_KEY`, from the environment) and permissive CORS. The key is
//    never logged and never returned.
//
// 2. **One lyric request per song.** Lookups are coalesced (concurrent requests
//    for the same track share one upstream fetch) and cached: found lyrics for a
//    week, a definite "no lyrics" for an hour. Four devices starting the same
//    song produce one upstream call; every later play of it produces none.
//
// 3. **Respect the rate limit.** The key has a request window per application
//    (`RateLimit-*` headers). When the API answers `429 rate_limited`, the proxy
//    stops forwarding until the window resets and answers `429` itself in the
//    meantime, instead of hammering an exhausted window. Cache hits keep being
//    served throughout.
//
// Run it with Docker Compose (see web/README.md):
//    cd web/server && cp .env.example .env   # put SPICY_API_KEY in it
//    docker compose up -d
//
// Verify (the key is never exposed):
//    GET http://<host>:8787/__spicy/stats

const API_ORIGIN = "https://api.spicylyrics.org";

// A Spotify track id: 22 base62 characters. Checked here too so a malformed id
// costs nothing upstream.
const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const LYRICS_PATH = /^\/v1\/lyrics\/([^/]+)\/?$/;

// --- config -----------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cfg(env) {
  const e = env || {};
  return {
    // Overridable so the proxy can be pointed at a mirror — and so the host's
    // end-to-end tests can run against a stub instead of the real API.
    apiOrigin: (e.API_ORIGIN || API_ORIGIN).replace(/\/$/, ""),
    apiKey: String(e.SPICY_API_KEY || "").trim(),
    logLevel: LEVELS[String(e.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info,
    lyricsCacheTtl: num(e.LYRICS_CACHE_TTL, 604800),
    lyricsMissCacheTtl: num(e.LYRICS_MISS_CACHE_TTL, 3600),
  };
}

// `sl_sk_…` → "secret", `sl_pk_…` → "publishable". Reported by /__spicy/stats
// so an operator can check which key is loaded without it being printed.
export function keyKind(key) {
  if (!key) return null;
  if (key.startsWith("sl_sk_")) return "secret";
  if (key.startsWith("sl_pk_")) return "publishable";
  return "unknown";
}

// Structured logging: one JSON object per line on stdout, so `docker compose
// logs` can be filtered on a field — `evt="upstream"` for calls that really
// reached api.spicylyrics.org, `evt="cache"` for lookups (state=hit | coalesced
// | miss). `LOG_LEVEL` tunes the volume.
function makeLog(env, where) {
  const min = cfg(env).logLevel;
  return (level, evt, fields) => {
    if ((LEVELS[level] ?? 0) < min) return;
    console.log({ level, src: where, evt, ...fields });
  };
}

// --- CORS -------------------------------------------------------------------

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type",
    "Access-Control-Expose-Headers":
      "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, X-Spicy-Cache, X-Spicy-Upstream",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// --- responses ----------------------------------------------------------------

// The API's own error shape, so the page parses the proxy's errors exactly like
// the API's.
function errorEnvelope(status, error, message) {
  return JSON.stringify({ Body: { error, message }, Status: status, Type: "object" });
}

function errorResponse(status, error, message, headers) {
  return new Response(errorEnvelope(status, error, message), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function json(obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// The API answers with JSON — always, including for its own errors. So an HTML
// body is never the API talking: something in front of it (a Cloudflare block
// or challenge page) answered instead, and the request did not reach the API.
// Detected on the content type, never on the page's wording.
function isUpstreamBlock(contentType) {
  return /text\/html/i.test(contentType || "");
}

// The API's machine-readable error code (`Body.error`), if the body has one.
function errorCode(buf) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    return typeof parsed?.Body?.error === "string" ? parsed.Body.error : null;
  } catch {
    return null;
  }
}

// Node's fetch rejects with a bare `TypeError: fetch failed` and puts the real
// reason in `cause` — ECONNREFUSED, ENOTFOUND, a TLS failure, or one of
// outbound.mjs's own messages when a configured PROXY_URL cannot be reached.
// Walk the chain so the log line says something useful.
function describeError(err) {
  const parts = [];
  let e = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const text = e?.code ? `${message} (${e.code})` : message;
    if (!parts.includes(text)) parts.push(text);
    e = e?.cause;
  }
  return parts.join(" <- ");
}

const RATE_HEADERS = ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"];

// --- the proxy --------------------------------------------------------------

/**
 * Build the request handler.
 *
 * `cache` stores API answers by track id, supplied by the host:
 *   match(id) -> { buf, contentType, status } | undefined
 *   put(id, { buf, contentType, status, ttl })   (ttl in seconds)
 */
export function createProxy({ env = {}, cache }) {
  const log = makeLog(env, "proxy");
  const inflight = new Map(); // id -> Promise<upstream result>
  const stats = {
    requests: 0,
    cacheHits: 0,
    coalesced: 0,
    upstream: 0,
    rateLimited: 0,
    blocked: 0,
    errors: 0,
  };
  // Last `RateLimit-*` the API reported, and until when we hold off after an
  // application-level 429.
  const rate = { limit: null, remaining: null, resetAt: null, cooldownUntil: 0 };
  let lastBlock = null;

  function noteRate(headers) {
    const limit = Number(headers.get("RateLimit-Limit"));
    const remaining = Number(headers.get("RateLimit-Remaining"));
    const reset = Number(headers.get("RateLimit-Reset"));
    if (headers.has("RateLimit-Limit") && Number.isFinite(limit)) rate.limit = limit;
    if (headers.has("RateLimit-Remaining") && Number.isFinite(remaining)) rate.remaining = remaining;
    if (headers.has("RateLimit-Reset") && Number.isFinite(reset)) {
      rate.resetAt = Date.now() + reset * 1000;
    }
  }

  async function fetchUpstream(id) {
    const c = cfg(env);
    const started = Date.now();
    stats.upstream++;
    try {
      const res = await fetch(`${c.apiOrigin}/v1/lyrics/${id}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${c.apiKey}` },
      });
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("Content-Type") || "application/json";
      noteRate(res.headers);

      if (isUpstreamBlock(contentType)) {
        stats.blocked++;
        lastBlock = { at: Date.now(), http: res.status };
        log("warn", "upstream_blocked", { id, http: res.status });
        return {
          status: 502,
          contentType: "application/json",
          buf: new TextEncoder().encode(
            errorEnvelope(502, "upstream_blocked", "The API answered with an HTML page instead of JSON: the proxy's network path is being blocked.")
          ).buffer,
          blocked: true,
          headers: {},
        };
      }

      const code = res.ok ? null : errorCode(buf);
      // Only the application's own window is a reason to stop forwarding.
      // `upstream_rate_limited` is the API's provider throttling one lookup,
      // and says nothing about our key.
      if (res.status === 429 && code === "rate_limited") {
        stats.rateLimited++;
        const wait = Number(res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset"));
        rate.cooldownUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000;
        log("warn", "rate_limited", { id, retryAfter: wait });
      }
      if (!res.ok && res.status !== 404) stats.errors++;

      log("info", "upstream", {
        id,
        http: res.status,
        error: code ?? undefined,
        bytes: buf.byteLength,
        remaining: rate.remaining,
        ms: Date.now() - started,
      });

      const headers = {};
      for (const name of RATE_HEADERS) {
        const v = res.headers.get(name);
        if (v !== null) headers[name] = v;
      }
      return { status: res.status, contentType, buf, headers };
    } catch (err) {
      stats.errors++;
      log("warn", "upstream_failed", { id, error: describeError(err) });
      return {
        status: 502,
        contentType: "application/json",
        buf: new TextEncoder().encode(
          errorEnvelope(502, "upstream_unreachable", "The proxy could not reach the lyrics API. Check its logs for evt=\"upstream_failed\".")
        ).buffer,
        unreachable: true,
        headers: {},
      };
    }
  }

  async function lyrics(id, cors) {
    const c = cfg(env);
    stats.requests++;

    if (!TRACK_ID.test(id)) {
      return errorResponse(400, "invalid_track_id", "A track id is 22 base62 characters, as it appears in a Spotify track URL.", cors);
    }

    const hit = await cache.match(id);
    if (hit) {
      stats.cacheHits++;
      log("debug", "cache", { id, state: "hit" });
      return new Response(hit.buf, {
        status: hit.status || 200,
        headers: { "Content-Type": hit.contentType || "application/json", "X-Spicy-Cache": "hit", ...cors },
      });
    }

    if (!c.apiKey) {
      return errorResponse(500, "proxy_not_configured", "SPICY_API_KEY is not set on the proxy.", cors);
    }

    const waitMs = rate.cooldownUntil - Date.now();
    if (waitMs > 0) {
      const retryAfter = String(Math.ceil(waitMs / 1000));
      log("debug", "cache", { id, state: "cooldown" });
      return errorResponse(429, "rate_limited", `The proxy's request window is exhausted. Retry in ${retryAfter}s.`, {
        ...cors,
        "Retry-After": retryAfter,
        "X-Spicy-Cache": "cooldown",
      });
    }

    let p = inflight.get(id);
    const coalesced = !!p;
    if (coalesced) {
      stats.coalesced++;
    } else {
      p = fetchUpstream(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    const r = await p;

    // Cache a found result for a long time; a definite "no lyrics" briefly (so a
    // song without lyrics isn't re-queried every play). Never cache errors,
    // rate limits or an upstream block.
    let ttl = 0;
    if (r.status === 200) ttl = c.lyricsCacheTtl;
    else if (r.status === 404) ttl = c.lyricsMissCacheTtl;
    if (ttl > 0 && !coalesced) {
      await cache.put(id, { buf: r.buf, contentType: r.contentType, status: r.status, ttl }).catch(() => {});
    }

    log("info", "cache", { id, state: coalesced ? "coalesced" : "miss", http: r.status, ttl });

    const out = {
      "Content-Type": r.contentType,
      "X-Spicy-Cache": coalesced ? "coalesced" : "miss",
      ...r.headers,
      ...cors,
    };
    // Lets the page say "the API blocked this proxy" or "the proxy can't reach
    // the API" instead of a generic error — they need different reactions.
    if (r.blocked) out["X-Spicy-Upstream"] = "blocked";
    if (r.unreachable) out["X-Spicy-Upstream"] = "unreachable";
    return new Response(r.buf, { status: r.status, headers: out });
  }

  /**
   * What the devices asked for versus what reached the API. `requests` counts
   * lookups; `upstream` counts calls that actually left this machine. The gap
   * is the cache and the coalescing at work.
   */
  function snapshot() {
    const c = cfg(env);
    return {
      keyConfigured: !!c.apiKey,
      keyKind: keyKind(c.apiKey),
      rateLimit: {
        limit: rate.limit,
        remaining: rate.remaining,
        resetsInSeconds: rate.resetAt ? Math.max(0, Math.round((rate.resetAt - Date.now()) / 1000)) : null,
        coolingDownForSeconds: Math.max(0, Math.ceil((rate.cooldownUntil - Date.now()) / 1000)),
      },
      upstreamBlocked: lastBlock
        ? {
            count: stats.blocked,
            lastAt: lastBlock.at,
            detail: "api.spicylyrics.org answered with an HTML page instead of JSON. The requests are not reaching the API.",
          }
        : null,
      stats: { ...stats },
    };
  }

  async function handle(request) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // Diagnostic: how much traffic actually reaches the Spicy Lyrics API.
    if (url.pathname === "/__spicy/stats") return json(snapshot(), cors);

    const m = LYRICS_PATH.exec(url.pathname);
    if (m) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse(405, "invalid_request", "Only GET is supported.", { ...cors, Allow: "GET, OPTIONS" });
      }
      return lyrics(decodeURIComponent(m[1]), cors);
    }

    return errorResponse(404, "not_found", "This proxy only serves GET /v1/lyrics/{trackId}.", cors);
  }

  return { fetch: handle, stats: snapshot };
}
