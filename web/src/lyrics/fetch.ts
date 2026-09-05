// Fetch synced lyrics from the Spicy Lyrics API — same protocol as the
// extension's `utils/Lyrics/fetchLyrics.ts` + `utils/API/Query.ts`, using the
// real SLObjPack unpacker from the engine.
import { SLObjPack } from "@src/utils/objpack.ts";
import { LYRICS_API, CLIENT_VERSION } from "../config.ts";
import { getAccessToken } from "../spotify/auth.ts";

const packer = new SLObjPack();

export type LyricsResult =
  | { ok: true; data: any }
  | {
      ok: false;
      reason: "not-found" | "queued" | "error" | "no-auth" | "blocked";
      status: number;
    };

const cache = new Map<string, any>();

// Persist fetched lyrics across sessions so revisiting a track never re-hits the
// API — the API rate-limits repeated queries, so cutting request volume directly
// helps. Lyrics are effectively immutable per track, so no TTL is needed.
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

export async function fetchLyrics(trackId: string): Promise<LyricsResult> {
  if (cache.has(trackId)) return { ok: true, data: cache.get(trackId) };
  const persisted = readPersisted(trackId);
  if (persisted) {
    cache.set(trackId, persisted);
    return { ok: true, data: persisted };
  }

  const token = await getAccessToken();
  if (!token) return { ok: false, reason: "no-auth", status: 401 };

  let res: Response;
  try {
    res = await fetch(`${LYRICS_API}/query`, {
      method: "POST",
      // Note: browsers forbid setting `Origin`, `Referer` and `User-Agent` from
      // fetch. If the API requires the Spotify-client values for those, route
      // LYRICS_API through the bundled proxy (web/proxy/), which injects them
      // server-side. These are the headers we CAN set from the page.
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        "SpicyLyrics-Version": CLIENT_VERSION,
        "X-mode": "2",
        "SpicyLyrics-WebAuth": `Bearer ${token}`,
      },
      body: JSON.stringify({
        queries: [
          {
            operation: "lyrics",
            variables: { id: trackId, auth: "SpicyLyrics-WebAuth" },
          },
        ],
        client: { version: CLIENT_VERSION },
      }),
    });
  } catch (err) {
    console.error("[SpicyLyrics] lyrics request failed", err);
    return { ok: false, reason: "error", status: 0 };
  }

  // The bundled Worker proxy sets this when api.spicylyrics.org answered with a
  // Cloudflare block page instead of an API response: the request never reached
  // the API, so it is neither a missing-lyrics case nor anything a retry fixes.
  if (res.headers.get("X-Spicy-Upstream") === "blocked") {
    return { ok: false, reason: "blocked", status: res.status };
  }
  if (!res.ok) return { ok: false, reason: "error", status: res.status };

  const json = await res.json();
  const result = json?.queries?.find((q: any) => q.operationId === "0")?.result
    ?? json?.queries?.[0]?.result;
  if (!result) return { ok: false, reason: "not-found", status: 404 };

  const status = result.httpStatus;
  if (status === 503) return { ok: false, reason: "queued", status };
  if (status === 404) return { ok: false, reason: "not-found", status };
  if (status !== 200) return { ok: false, reason: "error", status };

  let data: any;
  try {
    data = packer.unpack(result.data);
  } catch (err) {
    console.error("[SpicyLyrics] failed to unpack lyrics", err);
    return { ok: false, reason: "error", status: 500 };
  }
  if (!data) return { ok: false, reason: "not-found", status: 404 };

  data.uri = `spotify:track:${trackId}`;
  cache.set(trackId, data);
  writePersisted(trackId, data);
  return { ok: true, data };
}
