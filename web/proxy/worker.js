// Cloudflare Worker — CORS + header-injecting proxy for the Spicy Lyrics API.
//
// Why this exists: a browser cannot set the `Origin`, `Referer` or `User-Agent`
// request headers (they're "forbidden headers"), and the lyrics API expects the
// Spotify-client values for them. It also may not send CORS headers for your
// hosting origin. This Worker sits between the page and the API: it injects the
// expected headers server-side and adds permissive CORS so the browser is happy.
//
// Deploy (see web/proxy/README or the main README):
//   1. cd web/proxy && npx wrangler deploy
//   2. Point the site at it:  VITE_LYRICS_API=https://<your-worker>.workers.dev
//
// The user's Spotify Bearer token passes through in the `SpicyLyrics-WebAuth`
// header. This Worker never logs or stores it.

const API_ORIGIN = "https://api.spicylyrics.org";
const SPOTIFY_ORIGIN = "https://xpui.app.spotify.com";
const SPOTIFY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36";

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

export default {
  async fetch(request) {
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
    const auth = request.headers.get("SpicyLyrics-WebAuth");
    if (auth) headers.set("SpicyLyrics-WebAuth", auth);

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
    });

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
