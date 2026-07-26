// Cloudflare Worker — CORS + header/token proxy for the Spicy Lyrics API.
//
// Two jobs:
//
// 1. Inject the request headers a browser can't set (Origin/Referer/User-Agent)
//    and add permissive CORS, so the page can reach the API at all.
//
// 2. **Synced lyrics token.** Spotify's synced-lyrics endpoint only accepts the
//    official web-player client token. A third-party OAuth app token (all a
//    website can get) unlocks plain text only. So if you set an `SP_DC` secret
//    (your Spotify account cookie), the Worker mints a *web-player* token from
//    it server-side and uses THAT as the lyrics bearer. The cookie never touches
//    the browser and is never logged.
//
// Token minting uses Spotify's current web-player flow:
//    GET https://open.spotify.com/api/token?...&totp=<code>&totpServer=<code>&totpVer=<ver>
// where <code> is a TOTP (RFC 6238, HMAC-SHA1, 30s, 6 digits) over Spotify's
// server time using a shared secret. Spotify rotates the secret and bumps
// `totpVer` periodically (anti-scraping). If minting stops working, override:
//    npx wrangler secret put TOTP_SECRET   # the current digit-string secret
//    (and set TOTP_VER via a Worker variable to the matching version)
//
// Setup:
//    cd web/proxy
//    npm install
//    npx wrangler secret put SP_DC     # paste your sp_dc cookie value
//    npx wrangler deploy

const API_ORIGIN = "https://api.spicylyrics.org";
const SPOTIFY_ORIGIN = "https://xpui.app.spotify.com";
const SPOTIFY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36";

// Historically-working defaults. Override via env when Spotify rotates them.
const DEFAULT_TOTP_SECRET = "5507145853487499592248630329347";
const DEFAULT_TOTP_VER = "5";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, SpicyLyrics-Version, SpicyLyrics-WebAuth, X-mode, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
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

// Cache the minted web-player token for the life of the isolate.
let cachedToken = null; // { accessToken, expiresAt }

async function mintFromApiToken(env) {
  const secret = env.TOTP_SECRET || DEFAULT_TOTP_SECRET;
  const ver = env.TOTP_VER || DEFAULT_TOTP_VER;
  const t = await getServerTime(env);
  const code = await totp(secret, t);
  const url =
    `https://open.spotify.com/api/token?reason=init&productType=web-player` +
    `&totp=${code}&totpServer=${code}&totpVer=${ver}`;
  const res = await fetch(url, { headers: openSpotifyHeaders(env) });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.accessToken || json.isAnonymous) return null;
  return {
    accessToken: json.accessToken,
    expiresAt: json.accessTokenExpirationTimestampMs ?? Date.now() + 3_300_000,
  };
}

// Legacy endpoint — kept as a fallback for accounts where it still works.
async function mintFromGetAccessToken(env) {
  const res = await fetch(
    "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    { headers: openSpotifyHeaders(env) }
  );
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.accessToken || json.isAnonymous) return null;
  return {
    accessToken: json.accessToken,
    expiresAt: json.accessTokenExpirationTimestampMs ?? Date.now() + 3_300_000,
  };
}

async function getWebPlayerToken(env) {
  if (!env || !env.SP_DC) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }
  try {
    const minted = (await mintFromApiToken(env)) ?? (await mintFromGetAccessToken(env));
    if (!minted) return null;
    cachedToken = minted;
    return minted.accessToken;
  } catch (err) {
    console.warn("[proxy] token minting failed:", err && err.message);
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const inUrl = new URL(request.url);
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

    const upstream = await fetch(target, { method: request.method, headers, body });

    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      respHeaders.set(k, v);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
