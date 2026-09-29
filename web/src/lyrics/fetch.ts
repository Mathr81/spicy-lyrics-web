// Fetch lyrics from the official Spicy Lyrics API:
//
//   GET {LYRICS_API}/v1/lyrics/{trackId}   →  { Body: Lyrics, Status, Type }
//
// LYRICS_API is normally the bundled proxy (web/server/), which holds the API
// key server-side and adds CORS. A secret key (`sl_sk_…`) must never be shipped
// to a browser, so the page sends no key of its own unless a *publishable* one
// (`sl_pk_…`) is configured for calling the API directly.
//
// The API's `Body` already has the engine's shape (Type / Content / Lead /
// Syllables / Background, times in seconds); `toEngineShape` only renames the
// two fields the Applyer reads under older names.
import { LYRICS_API, LYRICS_API_KEY } from "../config.ts";

export type LyricsResult =
  | { ok: true; data: any }
  | {
      ok: false;
      reason: "not-found" | "busy" | "rate-limited" | "error" | "no-key" | "blocked";
      status: number;
    };

const cache = new Map<string, any>();

// Persist fetched lyrics across sessions so revisiting a track never re-hits the
// API — the key has a request window, so cutting request volume directly helps.
// Lyrics are effectively immutable per track, so no TTL is needed.
const STORE_PREFIX = "sl_lyrics_v1_";

function readPersisted(trackId: string): any | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + trackId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePersisted(trackId: string, data: any): void {
  try {
    localStorage.setItem(STORE_PREFIX + trackId, JSON.stringify(data));
  } catch {
    // Quota exceeded or storage unavailable — the in-memory cache still serves
    // this session; drop the oldest persisted entries to make room next time.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORE_PREFIX)) {
          localStorage.removeItem(key);
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
}

// The API names its catalogues in full; the Applyer's credit line and
// community badge match on the extension's short codes.
const SOURCE_CODES: Record<string, string> = {
  spicy_lyrics: "spl",
  apple_music: "aml",
  spotify: "spt",
};

function toEngineShape(body: any, trackId: string): any {
  const data = { ...body };
  if (typeof data.source === "string") data.source = SOURCE_CODES[data.source] ?? data.source;
  // The engine reads a community sync's credits from `TTMLUploadMetadata`.
  if (data.UploadAttribution && !data.TTMLUploadMetadata) {
    data.TTMLUploadMetadata = data.UploadAttribution;
  }
  data.uri = `spotify:track:${trackId}`;
  return data;
}

function failure(status: number, code: string | undefined): LyricsResult {
  if (status === 404) return { ok: false, reason: "not-found", status };
  // `rate_limited` is our key's window; `upstream_rate_limited` is the API's
  // own provider throttling this lookup, which is nothing we did.
  if (status === 429 && code !== "upstream_rate_limited") {
    return { ok: false, reason: "rate-limited", status };
  }
  if (status === 429 || status === 502 || status === 503) {
    return { ok: false, reason: "busy", status };
  }
  if (status === 401 || status === 403 || code === "proxy_not_configured") {
    return { ok: false, reason: "no-key", status };
  }
  return { ok: false, reason: "error", status };
}

export async function fetchLyrics(trackId: string): Promise<LyricsResult> {
  if (cache.has(trackId)) return { ok: true, data: cache.get(trackId) };
  const persisted = readPersisted(trackId);
  if (persisted) {
    cache.set(trackId, persisted);
    return { ok: true, data: persisted };
  }

  let res: Response;
  try {
    res = await fetch(`${LYRICS_API}/v1/lyrics/${encodeURIComponent(trackId)}`, {
      headers: {
        Accept: "application/json",
        ...(LYRICS_API_KEY ? { Authorization: `Bearer ${LYRICS_API_KEY}` } : {}),
      },
    });
  } catch (err) {
    console.error("[SpicyLyrics] lyrics request failed", err);
    return { ok: false, reason: "error", status: 0 };
  }

  // The bundled proxy sets this when api.spicylyrics.org answered with a
  // Cloudflare page instead of JSON: the request never reached the API, so it is
  // neither a missing-lyrics case nor anything a retry fixes.
  if (res.headers.get("X-Spicy-Upstream") === "blocked") {
    return { ok: false, reason: "blocked", status: res.status };
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON — handled below */
  }

  if (!res.ok) {
    const code = json?.Body?.error;
    if (code) console.warn(`[SpicyLyrics] lyrics API: ${code} — ${json.Body.message ?? ""}`);
    return failure(res.status, code);
  }

  const body = json?.Body;
  if (!body || typeof body.Type !== "string") {
    console.error("[SpicyLyrics] unexpected lyrics payload", json);
    return { ok: false, reason: "error", status: res.status };
  }

  const data = toEngineShape(body, trackId);
  cache.set(trackId, data);
  writePersisted(trackId, data);
  return { ok: true, data };
}
