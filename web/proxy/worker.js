// Cloudflare Worker — CORS + header/token proxy for the Spicy Lyrics API.
//
// Two jobs:
//
// 1. Inject the request headers a browser can't set (Origin/Referer/User-Agent)
//    and add permissive CORS, so the page can reach the API at all.
//
// 2. **Synced lyrics token.** Spotify's synced-lyrics endpoint is gated to the
//    official web-player client token — a third-party OAuth app token (what the
//    page gets) only unlocks plain text. So if you set an `SP_DC` secret (your
//    Spotify account cookie), the Worker mints a *web-player* access token from
//    it server-side and uses THAT as the lyrics bearer. The cookie never touches
//    the browser and is never logged.
//
// Setup:
//   cd web/proxy
//   npm install
//   npx wrangler secret put SP_DC     # paste your sp_dc cookie value
//   npx wrangler deploy
//
// Getting sp_dc: log in to https://open.spotify.com in a browser →
//   DevTools → Application → Cookies → https://open.spotify.com →
//   copy the value of the `sp_dc` cookie. It is long-lived; treat it as a
//   password. Without SP_DC the Worker still proxies, but lyrics stay text-only.

const API_ORIGIN = "https://api.spicylyrics.org";
const SPOTIFY_ORIGIN = "https://xpui.app.spotify.com";
const SPOTIFY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36";
const TOKEN_ENDPOINT =
  "https://open.spotify.com/get_access_token?reason=transport&productType=web_player";

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

// Cache the minted web-player token for the life of the isolate.
let cachedToken = null; // { accessToken, expiresAt }

async function getWebPlayerToken(env) {
  if (!env || !env.SP_DC) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      headers: {
        Cookie: `sp_dc=${env.SP_DC}`,
        "User-Agent": SPOTIFY_UA,
        "App-Platform": "WebPlayer",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // isAnonymous:true means the cookie was rejected (expired/invalid, or
    // Spotify now demands a TOTP for this account).
    if (!json.accessToken || json.isAnonymous) return null;
    cachedToken = {
      accessToken: json.accessToken,
      expiresAt: json.accessTokenExpirationTimestampMs ?? Date.now() + 3_300_000,
    };
    return cachedToken.accessToken;
  } catch {
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
