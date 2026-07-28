// Cloudflare Worker — CORS + header/token proxy for the Spicy Lyrics API.
//
// Two jobs:
//
// 1. Inject the request headers a browser can't set (Origin/Referer/User-Agent)
//    and add permissive CORS, so the page can reach the API at all.
//
// 2. **Synced lyrics token.** Spotify's synced-lyrics endpoint only accepts the
//    official web-player client token. A third-party OAuth app token (all a
//    website can get) unlocks plain text only. With an `SP_DC` secret (your
//    Spotify account cookie), the Worker mints a web-player token server-side and
//    uses it as the lyrics bearer. The cookie never reaches the browser and is
//    never logged.
//
// Token minting mirrors what the web player / librespot do: call
//    GET https://open.spotify.com/api/token?...&totp=<code>&totpVer=<ver>
// with a TOTP (RFC 6238, HMAC-SHA1, 30s, 6 digits) over Spotify's server time.
// The TOTP key comes from a per-version "secret cipher" that Spotify rotates and
// bumps (`totpVer`). We ship the known ciphers AND fetch the community-maintained
// list so this keeps working across rotations without a code change.
//
// Setup:
//    cd web/proxy
//    npm install
//    npx wrangler secret put SP_DC     # paste your sp_dc cookie value
//    npx wrangler deploy
//
// Verify (no token exposed):  GET https://<your-worker>/__spicy/tokencheck

const API_ORIGIN = "https://api.spicylyrics.org";
const SPOTIFY_ORIGIN = "https://xpui.app.spotify.com";
const SPOTIFY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36";

// Community-maintained list of per-version TOTP secret ciphers. Auto-updates the
// Worker when Spotify rotates the secret. Override/disable via env.
const SECRET_DICT_URL =
  "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json";

// Baked-in fallback (used if the fetch fails). Keep the highest last.
const FALLBACK_SECRET_CIPHER = {
  59: [123, 105, 79, 70, 110, 59, 52, 125, 60, 49, 80, 70, 89, 75, 80, 86, 63, 53, 123, 37, 117, 49, 52, 93, 77, 62, 47, 86, 48, 104, 68, 72],
  60: [79, 109, 69, 123, 90, 65, 46, 74, 94, 34, 58, 48, 70, 71, 92, 85, 122, 63, 91, 64, 87, 87],
  61: [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78],
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, SpicyLyrics-Version, SpicyLyrics-WebAuth, X-mode, Accept, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// True if the request body contains a session-lifecycle operation that the API
// authorizes via the `Authorization` header (session creation / refresh).
function needsSessionAuth(bodyBuffer) {
  try {
    const text = new TextDecoder().decode(bodyBuffer);
    const parsed = JSON.parse(text);
    const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
    return queries.some(
      (q) => q?.operation === "createSession" || q?.operation === "refreshSession"
    );
  } catch {
    return false;
  }
}

// If the body is a single `lyrics` query, return the track id used as the cache
// key; otherwise null (only plain lyric lookups are edge-cached, never session
// ops or multi-operation batches).
function lyricsCacheId(bodyBuffer) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBuffer));
    const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
    if (queries.length !== 1) return null;
    const q = queries[0];
    const id = q?.variables?.id;
    if (q?.operation === "lyrics" && typeof id === "string" && /^[A-Za-z0-9]+$/.test(id)) {
      return id;
    }
    return null;
  } catch {
    return null;
  }
}

// The /query endpoint returns HTTP 200 with a per-operation `httpStatus` inside;
// pull that inner status so we only cache real results (200) / definite misses
// (404), never queued (503) or transient errors.
function lyricsResultStatus(bodyBuffer) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBuffer));
    const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
    const result =
      queries.find((q) => q?.operationId === "0")?.result ?? queries[0]?.result;
    return typeof result?.httpStatus === "number" ? result.httpStatus : 0;
  } catch {
    return 0;
  }
}

function cacheRespHeaders(request, cachedResponse, state) {
  const h = new Headers();
  h.set("Content-Type", cachedResponse.headers.get("Content-Type") || "application/json");
  h.set("X-Spicy-Cache", state);
  for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
  return h;
}

function openSpotifyHeaders(env) {
  const h = {
    "User-Agent": SPOTIFY_UA,
    Accept: "application/json",
    Origin: "https://open.spotify.com",
    Referer: "https://open.spotify.com/",
    "App-Platform": "WebPlayer",
  };
  if (env && env.SP_DC) h.Cookie = `sp_dc=${env.SP_DC}`;
  return h;
}

// --- TOTP (RFC 6238) via Web Crypto -----------------------------------------
function counterBytes(counter) {
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return buf;
}

async function totp(secretStr, timeSeconds, period = 30, digits = 6) {
  const keyBytes = new TextEncoder().encode(secretStr);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const counter = Math.floor(timeSeconds / period);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes(counter)));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

// Spotify's key derivation: XOR each cipher byte with ((index % 33) + 9), then
// join the resulting decimal values into one string used as the TOTP key.
function secretStringFromCipher(cipher) {
  return cipher.map((e, t) => e ^ ((t % 33) + 9)).join("");
}

async function getServerTime(env) {
  try {
    const res = await fetch("https://open.spotify.com/api/server-time", {
      headers: openSpotifyHeaders(env),
    });
    const json = await res.json();
    if (json && json.serverTime) return Number(json.serverTime);
  } catch {
    /* fall through */
  }
  return Math.floor(Date.now() / 1000);
}

let secretDictCache = null; // { dict, at }

async function getSecretDict(env) {
  if (env && env.DISABLE_SECRET_FETCH === "1") return FALLBACK_SECRET_CIPHER;
  if (secretDictCache && Date.now() - secretDictCache.at < 6 * 3600_000) {
    return secretDictCache.dict;
  }
  try {
    const url = (env && env.SECRET_DICT_URL) || SECRET_DICT_URL;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const dict = await res.json();
      if (dict && typeof dict === "object" && Object.keys(dict).length) {
        secretDictCache = { dict, at: Date.now() };
        return dict;
      }
    }
  } catch {
    /* fall through */
  }
  secretDictCache = { dict: FALLBACK_SECRET_CIPHER, at: Date.now() };
  return FALLBACK_SECRET_CIPHER;
}

// Cache the minted web-player token for the life of the isolate.
let cachedToken = null; // { accessToken, expiresAt }

async function mintToken(env) {
  const dict = await getSecretDict(env);
  const versions = env && env.TOTP_VER
    ? [String(env.TOTP_VER)]
    : Object.keys(dict).sort((a, b) => Number(b) - Number(a)); // highest first
  const t = await getServerTime(env);

  for (const ver of versions) {
    const secret = (env && env.TOTP_SECRET) || (dict[ver] && secretStringFromCipher(dict[ver]));
    if (!secret) continue;
    const code = await totp(secret, t);
    for (const reason of ["transport", "init"]) {
      const url =
        `https://open.spotify.com/api/token?reason=${reason}&productType=web-player` +
        `&totp=${code}&totpServer=${code}&totpVer=${ver}`;
      try {
        const res = await fetch(url, { headers: openSpotifyHeaders(env) });
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        if (json && json.accessToken && !json.isAnonymous) {
          return {
            accessToken: json.accessToken,
            expiresAt: json.accessTokenExpirationTimestampMs ?? Date.now() + 3_300_000,
            version: ver,
          };
        }
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function getWebPlayerToken(env) {
  if (!env || !env.SP_DC) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }
  const minted = await mintToken(env);
  if (!minted) return null;
  cachedToken = minted;
  return minted.accessToken;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const inUrl = new URL(request.url);

    // Diagnostic: confirms token minting works without ever exposing the token.
    if (inUrl.pathname === "/__spicy/tokencheck") {
      const cors = corsHeaders(request);
      if (!env || !env.SP_DC) {
        return json({ ok: false, reason: "SP_DC not set" }, cors);
      }
      cachedToken = null;
      const minted = await mintToken(env);
      return json(
        minted
          ? { ok: true, totpVer: minted.version }
          : { ok: false, reason: "minting failed (cookie expired or secret rotated)" },
        cors
      );
    }

    const target = API_ORIGIN + inUrl.pathname + inUrl.search;

    const headers = new Headers();
    headers.set("Accept", "*/*");
    headers.set("Content-Type", "application/json");
    headers.set("Origin", SPOTIFY_ORIGIN);
    headers.set("Referer", SPOTIFY_ORIGIN + "/");
    headers.set("User-Agent", SPOTIFY_UA);
    headers.set("X-mode", request.headers.get("X-mode") || "2");
    headers.set(
      "SpicyLyrics-Version",
      request.headers.get("SpicyLyrics-Version") || "6.2.3"
    );

    // Prefer a web-player token minted from SP_DC (unlocks synced lyrics);
    // otherwise fall through to whatever token the page sent (text only).
    const webPlayerToken = await getWebPlayerToken(env);
    const auth = webPlayerToken
      ? `Bearer ${webPlayerToken}`
      : request.headers.get("SpicyLyrics-WebAuth");
    if (auth) headers.set("SpicyLyrics-WebAuth", auth);

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    // The Spicy Lyrics API (v6.2.3+) uses a session model: clients call
    // `createSession` (→ session token) and keep it alive with `ping`/
    // `refreshSession`/`pingConfig`. Non-session `/query` traffic gets rate
    // limited. The session-creating ops read the `Authorization` header (a
    // Spotify token) — which a browser can't set and this worker otherwise
    // drops. Inject the same web-player token used for lyrics so the session
    // and the lyric queries share one identity. Only for the session ops, to
    // avoid touching lyric-query behaviour.
    if (webPlayerToken && body && needsSessionAuth(body)) {
      headers.set("Authorization", `Bearer ${webPlayerToken}`);
    }

    // Edge cache for lyric lookups. Lyrics are immutable per track, so the first
    // device to request a song populates the cache and every later request (any
    // device through this Worker) is served from the edge without hitting Spicy
    // Lyrics again — collapsing N devices into one upstream call per song. Only
    // single `lyrics` queries are cached; session ops always pass through. The
    // cached entry stores just the body (no per-request CORS), so CORS headers
    // are re-applied fresh on every response.
    const cacheId = body ? lyricsCacheId(body) : null;
    const cache = caches.default;
    const cacheKey = cacheId
      ? new Request(`https://slcache.internal/lyrics/${cacheId}`, { method: "GET" })
      : null;

    if (cacheKey) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cachedBody = await hit.arrayBuffer();
        return new Response(cachedBody, {
          status: 200,
          headers: cacheRespHeaders(request, hit, "hit"),
        });
      }
    }

    const upstream = await fetch(target, { method: request.method, headers, body });

    // Non-cacheable (session ops, non-lyrics): stream straight through as before.
    if (!cacheKey) {
      const respHeaders = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(corsHeaders(request))) {
        respHeaders.set(k, v);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    }

    // Cacheable path: buffer so we can inspect the inner result and store it.
    const buf = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("Content-Type") || "application/json";
    const innerStatus = lyricsResultStatus(buf);

    // Cache a found result for a long time; a definite "not found" briefly (so a
    // song without lyrics isn't re-queried every play). Never cache 503 (queued)
    // or transient errors.
    let ttl = 0;
    if (upstream.status === 200 && innerStatus === 200) ttl = 604800; // 7 days
    else if (upstream.status === 200 && innerStatus === 404) ttl = 3600; // 1 hour
    if (ttl > 0) {
      const toCache = new Response(buf, {
        headers: { "Content-Type": contentType, "Cache-Control": `max-age=${ttl}` },
      });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }

    const respHeaders = new Headers();
    respHeaders.set("Content-Type", contentType);
    respHeaders.set("X-Spicy-Cache", "miss");
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      respHeaders.set(k, v);
    }
    return new Response(buf, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};

function json(obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
