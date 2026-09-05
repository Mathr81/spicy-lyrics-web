// Cloudflare Worker — CORS + header/token proxy AND shared-identity front end
// for the Spicy Lyrics API.
//
// Four jobs:
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
// 3. **One identity, N devices.** The API's session model expects a client to
//    open a session and keep it alive. Every browser doing that on its own means
//    4 devices = 4 sessions, 4 ping loops and 4 identical lyric lookups — which
//    is exactly the traffic pattern that gets a client rate-limited or flagged.
//    So session lifecycle ops (`createSession` / `refreshSession` / `ping` /
//    `pingConfig`) are **answered locally** and never forwarded per-client: a
//    single Durable Object owns ONE upstream session for the whole deployment
//    and keeps it alive on its own alarm schedule, whether one device is
//    connected or ten.
//
// 4. **One lyric request per song.** Lyric lookups are coalesced (concurrent
//    requests for the same track share a single upstream fetch, in the Worker
//    *and* in the Durable Object) and then cached at the edge. Four devices
//    starting the same song at the same moment produce exactly one upstream
//    call; every later play of that song produces none.
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
// Verify (no token exposed):
//    GET https://<your-worker>/__spicy/tokencheck   # can we mint a token?
//    GET https://<your-worker>/__spicy/stats        # how much upstream traffic?

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

// Session-lifecycle operations. These never reach the upstream API per client —
// the shared session hub answers them (see `sessionEnvelope`).
const SESSION_OPS = new Set([
  "createSession",
  "refreshSession",
  "ping",
  "pingConfig",
]);

// The token clients get back for their "session". Deliberately NOT the real
// upstream token: the browser has no use for it, and handing it out would let a
// client talk to the API directly under the shared identity, defeating the point.
const CLIENT_TOKEN = "spicy-proxy-shared-session";

// What the upstream API asks of a well-behaved client, until `pingConfig` tells
// us otherwise. Only the hub uses these — clients get `clientPingConfig()`.
const UPSTREAM_DEFAULTS = {
  pingIntervalMs: 300000,
  minPingIntervalMs: 240000,
  sessionTtlSeconds: 3600,
  refreshAtTtlFraction: 0.8,
};

const OK = 200;
const SESSION_DEAD = 403;
const CREATE_BACKOFF_BASE_MS = 15000;
const CREATE_BACKOFF_MAX_MS = 900000; // 15 min — a dead cookie must not be retried hot

// --- config -----------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cfg(env) {
  const e = env || {};
  return {
    logLevel: LEVELS[String(e.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info,
    clientVersion: e.CLIENT_VERSION || "6.3.12",
    lyricsCacheTtl: num(e.LYRICS_CACHE_TTL, 604800),
    lyricsMissCacheTtl: num(e.LYRICS_MISS_CACHE_TTL, 3600),
    clientPingIntervalMs: num(e.CLIENT_PING_INTERVAL_MS, 900000),
    clientSessionTtlS: num(e.CLIENT_SESSION_TTL_S, 86400),
    sessionIdleMs: num(e.SESSION_IDLE_MS, 1800000),
  };
}

// Structured logging. Workers Logs indexes the object's fields, so
// `evt = "upstream"` / `evt = "cache"` are filterable in the dashboard.
// Enabled by `[observability]` in wrangler.toml; `LOG_LEVEL` tunes the volume
// without a redeploy (`npx wrangler deploy --var LOG_LEVEL:debug`).
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
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, SpicyLyrics-Version, SpicyLyrics-WebAuth, X-mode, Accept, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// --- request classification -------------------------------------------------

// Sort an incoming `/query` body into the three paths that matter:
//   session  — lifecycle ops, answered locally, never forwarded per client
//   lyrics   — a single track lookup: coalesced + edge-cached
//   other    — anything else: plain passthrough, as before
function classify(bodyBuffer) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBuffer));
    const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
    if (!queries.length) return { type: "other" };
    if (queries.every((q) => SESSION_OPS.has(q?.operation))) {
      return { type: "session", queries };
    }
    if (queries.length === 1 && queries[0]?.operation === "lyrics") {
      const id = queries[0]?.variables?.id;
      if (typeof id === "string" && /^[A-Za-z0-9]{1,64}$/.test(id)) {
        return { type: "lyrics", id };
      }
    }
    return { type: "other" };
  } catch {
    return { type: "other" };
  }
}

// A Cloudflare challenge/block page from the upstream zone, rather than an API
// response. Worth naming explicitly: it is not a lyrics error, not a bad token
// and not something a retry fixes — the request never reached the API. Detected
// so it can be logged, reported by /__spicy/stats and shown to the user as what
// it is instead of a generic failure.
function blockedLyricsResult() {
  const body = JSON.stringify({
    error: "upstream-blocked",
    queries: [
      {
        operationId: "0",
        operation: "lyrics",
        result: { httpStatus: 403, data: null },
      },
    ],
  });
  return {
    status: 403,
    contentType: "application/json",
    buf: new TextEncoder().encode(body).buffer,
    blocked: true,
  };
}

function isUpstreamBlock(status, contentType, buf) {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  if (!/text\/html/i.test(contentType || "")) return false;
  try {
    const head = new TextDecoder().decode(buf.slice(0, 4096));
    return /Attention Required|cf-error|Cloudflare Ray ID|you have been blocked/i.test(head);
  } catch {
    return false;
  }
}

// The /query endpoint returns HTTP 200 with a per-operation `httpStatus` inside;
// pull that inner status so we only cache real results (200) / definite misses
// (404), never queued (503) or transient errors.
function innerStatus(bodyBuffer) {
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

// What we tell clients to do with their (proxy-local) session. Long intervals:
// these pings cost nothing upstream, so there is no reason for four devices to
// wake up every five minutes. The hub keeps the *real* session alive on the
// upstream schedule regardless of what clients do.
function clientPingConfig(c) {
  return {
    pingIntervalMs: c.clientPingIntervalMs,
    minPingIntervalMs: c.clientPingIntervalMs,
    sessionTtlSeconds: c.clientSessionTtlS,
    refreshAtTtlFraction: 0.9,
  };
}

// Build the `/query` response shape the client parses, for ops we answer here.
function sessionEnvelope(queries, c) {
  return {
    queries: queries.map((q, i) => {
      const op = q?.operation;
      let data;
      if (op === "createSession" || op === "refreshSession") data = { tk: CLIENT_TOKEN };
      else if (op === "pingConfig") data = clientPingConfig(c);
      else data = { ok: true };
      return {
        operationId: q?.operationId ?? String(i),
        operation: op,
        result: { httpStatus: OK, data },
      };
    }),
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

// Headers for an upstream Spicy Lyrics call. `auth` is the minted web-player
// token (or null); session ops additionally need it in `Authorization`.
function upstreamHeaders(env, auth, withAuthorization) {
  const c = cfg(env);
  const h = new Headers();
  h.set("Accept", "*/*");
  h.set("Content-Type", "application/json");
  h.set("Origin", SPOTIFY_ORIGIN);
  h.set("Referer", SPOTIFY_ORIGIN + "/");
  h.set("User-Agent", SPOTIFY_UA);
  h.set("X-mode", "2");
  h.set("SpicyLyrics-Version", c.clientVersion);
  if (auth) {
    h.set("SpicyLyrics-WebAuth", `Bearer ${auth}`);
    if (withAuthorization) h.set("Authorization", `Bearer ${auth}`);
  }
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
let cachedToken = null; // { accessToken, expiresAt, version }
let mintingToken = null; // in-flight mint, so concurrent callers share one

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
  // Coalesce: a burst of requests after expiry must mint once, not N times.
  if (!mintingToken) {
    mintingToken = mintToken(env).finally(() => {
      mintingToken = null;
    });
  }
  const minted = await mintingToken;
  if (!minted) return null;
  cachedToken = minted;
  return minted.accessToken;
}

// ---------------------------------------------------------------------------
// Shared session hub
//
// Owns the single upstream session and every upstream lyric fetch. Implemented
// as a Durable Object so the "single" is a real guarantee across colos, isolates
// and devices — a Worker isolate is per-location and short-lived, so isolate
// globals alone would drift back into one session per location.
// ---------------------------------------------------------------------------

export class SpicySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.log = makeLog(env, "hub");
    this.inflight = new Map(); // trackId -> Promise<{status, contentType, buf}>
    this.creating = null;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.s = (await state.storage.get("s")) || {
        tk: null,
        createdAt: 0,
        lastUpstreamAt: 0,
        lastClientAt: 0,
        nextCreateAt: 0,
        createBackoff: CREATE_BACKOFF_BASE_MS,
        config: { ...UPSTREAM_DEFAULTS },
        stats: {
          since: Date.now(),
          createSession: 0,
          refreshSession: 0,
          ping: 0,
          pingConfig: 0,
          lyricsUpstream: 0,
          lyricsCoalesced: 0,
          clientOps: 0,
          blocked: 0,
        },
        lastBlockAt: 0,
      };
    });
  }

  save() {
    return this.state.storage.put("s", this.s);
  }

  // Fire-and-forget work that must not block the client's response.
  // `DurableObjectState.waitUntil` only exists on newer runtimes; a DO stays
  // alive for its own pending promises anyway, so falling back to a bare
  // promise (with the rejection swallowed) is safe.
  bg(promise) {
    const p = Promise.resolve(promise).catch((err) =>
      this.log("warn", "background_failed", { error: String(err) })
    );
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(p);
  }

  // Loud, and at warn level: an operator staring at "lyrics don't load" needs
  // this to be the first thing they see in the logs.
  noteBlock(op, http) {
    this.s.stats.blocked++;
    this.s.lastBlockAt = Date.now();
    this.log("warn", "upstream_blocked", {
      op,
      http,
      detail:
        "api.spicylyrics.org returned a Cloudflare block page — the request " +
        "never reached the API. This is an upstream network/WAF decision, not " +
        "a token or session problem.",
    });
  }

  keepAliveMs() {
    return Math.max(this.s.config.pingIntervalMs, this.s.config.minPingIntervalMs);
  }

  async armAlarm() {
    const at = await this.state.storage.getAlarm();
    const want = Date.now() + this.keepAliveMs();
    // Only (re)arm if there is no alarm or the pending one is far too late.
    if (at === null || at > want + 60_000) await this.state.storage.setAlarm(want);
  }

  // One upstream `/query` call, with the shared identity.
  async upstream(queries, withAuthorization, tag) {
    const token = await getWebPlayerToken(this.env);
    const started = Date.now();
    try {
      const res = await fetch(`${API_ORIGIN}/query`, {
        method: "POST",
        headers: upstreamHeaders(this.env, token, withAuthorization),
        body: JSON.stringify({
          queries,
          client: { version: cfg(this.env).clientVersion },
        }),
      });
      const raw = await res.arrayBuffer();
      const blocked = isUpstreamBlock(res.status, res.headers.get("Content-Type"), raw);
      if (blocked) this.noteBlock(tag, res.status);
      let result = null;
      if (res.ok && !blocked) {
        try {
          const json = JSON.parse(new TextDecoder().decode(raw));
          result =
            json?.queries?.find((q) => q.operationId === "0")?.result ??
            json?.queries?.[0]?.result ??
            null;
        } catch {
          result = null;
        }
      }
      if (!blocked) {
        this.log("info", "upstream", {
          op: tag,
          http: res.status,
          inner: result?.httpStatus ?? null,
          ms: Date.now() - started,
        });
      }
      this.s.lastUpstreamAt = Date.now();
      return result;
    } catch (err) {
      this.log("warn", "upstream_failed", { op: tag, error: String(err) });
      return null;
    }
  }

  async syncPingConfig() {
    const r = await this.upstream([{ operation: "pingConfig", variables: {} }], false, "pingConfig");
    this.s.stats.pingConfig++;
    const d = r?.httpStatus === OK ? r.data : null;
    if (!d || typeof d !== "object") return;
    const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
    if (pos(d.pingIntervalMs)) this.s.config.pingIntervalMs = d.pingIntervalMs;
    if (pos(d.minPingIntervalMs)) this.s.config.minPingIntervalMs = d.minPingIntervalMs;
    if (pos(d.sessionTtlSeconds)) this.s.config.sessionTtlSeconds = d.sessionTtlSeconds;
    if (pos(d.refreshAtTtlFraction) && d.refreshAtTtlFraction <= 1) {
      this.s.config.refreshAtTtlFraction = d.refreshAtTtlFraction;
    }
  }

  // Open the one shared session. Failures back off hard (up to 15 min) so a
  // dead SP_DC cookie can never turn into a retry storm against the API —
  // clients are answered locally either way and never see the difference.
  ensureSession() {
    if (this.s.tk) return Promise.resolve(this.s.tk);
    if (this.creating) return this.creating;
    if (Date.now() < this.s.nextCreateAt) return Promise.resolve(null);

    this.creating = (async () => {
      await this.syncPingConfig();
      const r = await this.upstream(
        [{ operation: "createSession", variables: {} }],
        true,
        "createSession"
      );
      this.s.stats.createSession++;
      if (r?.httpStatus === OK && r.data?.tk) {
        this.s.tk = r.data.tk;
        this.s.createdAt = Date.now();
        this.s.createBackoff = CREATE_BACKOFF_BASE_MS;
        this.s.nextCreateAt = 0;
        this.log("info", "session_opened", {});
        await this.armAlarm();
      } else {
        this.s.nextCreateAt = Date.now() + this.s.createBackoff;
        this.s.createBackoff = Math.min(this.s.createBackoff * 2, CREATE_BACKOFF_MAX_MS);
        this.log("warn", "session_open_failed", { retryInMs: this.s.createBackoff });
      }
      await this.save();
      return this.s.tk;
    })().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  async dropSession(why) {
    this.log("info", "session_dropped", { why });
    this.s.tk = null;
    this.s.createdAt = 0;
    await this.state.storage.deleteAlarm();
    await this.save();
  }

  // Keep-alive. Runs on the DO's own alarm, so the upstream ping cadence is
  // fixed by the API's config and completely independent of how many devices
  // are connected (or whether any of them is awake).
  async alarm() {
    await this.ready;
    if (!this.s.tk) return;

    const idleFor = Date.now() - this.s.lastClientAt;
    if (idleFor > cfg(this.env).sessionIdleMs) {
      // Nobody is listening. Let the session lapse rather than ping forever.
      await this.dropSession("idle");
      return;
    }

    const ttlMs = this.s.config.sessionTtlSeconds * 1000;
    const due = this.s.createdAt + ttlMs * this.s.config.refreshAtTtlFraction;
    if (Date.now() >= due) {
      await this.syncPingConfig();
      const r = await this.upstream(
        [{ operation: "refreshSession", variables: { tk: this.s.tk } }],
        true,
        "refreshSession"
      );
      this.s.stats.refreshSession++;
      if (r?.httpStatus === OK && r.data?.tk) {
        this.s.tk = r.data.tk;
        this.s.createdAt = Date.now();
      } else if (r?.httpStatus === SESSION_DEAD || !r) {
        this.s.tk = null;
        await this.save();
        await this.ensureSession();
        await this.armAlarm();
        return;
      }
    } else {
      const r = await this.upstream(
        [{ operation: "ping", variables: { tk: this.s.tk } }],
        false,
        "ping"
      );
      this.s.stats.ping++;
      if (r?.httpStatus === SESSION_DEAD) {
        this.s.tk = null;
        await this.save();
        await this.ensureSession();
        await this.armAlarm();
        return;
      }
    }

    await this.save();
    await this.state.storage.setAlarm(Date.now() + this.keepAliveMs());
  }

  // A client's session op. Nothing is forwarded: we only note that somebody is
  // listening, make sure the shared session exists, and keep the alarm armed.
  async touch() {
    this.s.lastClientAt = Date.now();
    this.s.stats.clientOps++;
    this.bg(
      (async () => {
        await this.ensureSession();
        await this.armAlarm();
        await this.save();
      })()
    );
  }

  // Upstream lyric fetch, coalesced per track id.
  async lyrics(id, bodyText) {
    this.s.lastClientAt = Date.now();
    let p = this.inflight.get(id);
    if (p) {
      this.s.stats.lyricsCoalesced++;
      this.log("debug", "lyrics_coalesced", { id });
    } else {
      this.s.stats.lyricsUpstream++;
      p = this.fetchLyrics(id, bodyText).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
      this.bg(this.ensureSession());
    }
    this.bg(this.save());
    return p;
  }

  async fetchLyrics(id, bodyText) {
    const token = await getWebPlayerToken(this.env);
    const started = Date.now();
    try {
      const res = await fetch(`${API_ORIGIN}/query`, {
        method: "POST",
        headers: upstreamHeaders(this.env, token, false),
        body: bodyText,
      });
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("Content-Type") || "application/json";
      this.s.lastUpstreamAt = Date.now();

      if (isUpstreamBlock(res.status, contentType, buf)) {
        this.noteBlock("lyrics", res.status);
        // Never hand a Cloudflare HTML page to the page's JSON parser, and never
        // cache it (only inner-200/404 are cached). Return something the client
        // can name.
        return blockedLyricsResult();
      }

      this.log("info", "upstream", {
        op: "lyrics",
        id,
        http: res.status,
        inner: innerStatus(buf),
        bytes: buf.byteLength,
        ms: Date.now() - started,
      });
      return { status: res.status, contentType, buf };
    } catch (err) {
      this.log("warn", "upstream_failed", { op: "lyrics", id, error: String(err) });
      return {
        status: 502,
        contentType: "application/json",
        buf: new TextEncoder().encode(JSON.stringify({ queries: [] })).buffer,
      };
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/touch") {
      await this.touch();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/lyrics") {
      const id = request.headers.get("x-slp-id") || "";
      const r = await this.lyrics(id, await request.text());
      const h = { "Content-Type": r.contentType };
      // The flag has to travel as a header: only the body crosses this boundary.
      if (r.blocked) h["X-Spicy-Upstream"] = "blocked";
      return new Response(r.buf, { status: r.status, headers: h });
    }

    if (url.pathname === "/stats") {
      return Response.json({
        mode: "durable-object",
        sessionOpen: !!this.s.tk,
        sessionAgeSeconds: this.s.createdAt ? Math.round((Date.now() - this.s.createdAt) / 1000) : 0,
        upstreamKeepAliveEverySeconds: Math.round(this.keepAliveMs() / 1000),
        lastUpstreamAt: this.s.lastUpstreamAt || null,
        lastClientAt: this.s.lastClientAt || null,
        upstreamBlocked: this.s.stats.blocked
          ? {
              count: this.s.stats.blocked,
              lastAt: this.s.lastBlockAt,
              detail:
                "api.spicylyrics.org is returning a Cloudflare block page to " +
                "this Worker. The requests are not reaching the API.",
            }
          : null,
        upstreamConfig: this.s.config,
        stats: this.s.stats,
      });
    }

    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Fallback hub — used only when no Durable Object binding exists (e.g. the
// worker was pasted straight into the dashboard). Same contract, weaker
// guarantee: state lives in the isolate, so "one session" holds per isolate
// rather than globally, and the keep-alive piggybacks on client pings instead
// of an alarm. Still collapses N devices in the common single-location case.
// ---------------------------------------------------------------------------

const memHub = {
  tk: null,
  createdAt: 0,
  lastUpstreamAt: 0,
  lastKeepAliveAt: 0,
  nextCreateAt: 0,
  createBackoff: CREATE_BACKOFF_BASE_MS,
  creating: null,
  config: { ...UPSTREAM_DEFAULTS },
  inflight: new Map(),
  stats: {
    since: Date.now(),
    createSession: 0,
    refreshSession: 0,
    ping: 0,
    pingConfig: 0,
    lyricsUpstream: 0,
    lyricsCoalesced: 0,
    clientOps: 0,
    blocked: 0,
  },
  lastBlockAt: 0,
};

function memNoteBlock(env, op, http) {
  memHub.stats.blocked++;
  memHub.lastBlockAt = Date.now();
  makeLog(env, "hub-mem")("warn", "upstream_blocked", {
    op,
    http,
    detail: "api.spicylyrics.org returned a Cloudflare block page — the request never reached the API.",
  });
}

async function memUpstream(env, queries, withAuthorization, tag) {
  const log = makeLog(env, "hub-mem");
  const token = await getWebPlayerToken(env);
  try {
    const res = await fetch(`${API_ORIGIN}/query`, {
      method: "POST",
      headers: upstreamHeaders(env, token, withAuthorization),
      body: JSON.stringify({ queries, client: { version: cfg(env).clientVersion } }),
    });
    const raw = await res.arrayBuffer();
    memHub.lastUpstreamAt = Date.now();
    if (isUpstreamBlock(res.status, res.headers.get("Content-Type"), raw)) {
      memNoteBlock(env, tag, res.status);
      return null;
    }
    let result = null;
    if (res.ok) {
      try {
        const json = JSON.parse(new TextDecoder().decode(raw));
        result =
          json?.queries?.find((q) => q.operationId === "0")?.result ??
          json?.queries?.[0]?.result ??
          null;
      } catch {
        result = null;
      }
    }
    log("info", "upstream", { op: tag, http: res.status, inner: result?.httpStatus ?? null });
    return result;
  } catch (err) {
    log("warn", "upstream_failed", { op: tag, error: String(err) });
    return null;
  }
}

async function memEnsure(env) {
  if (memHub.tk) return memHub.tk;
  if (memHub.creating) return memHub.creating;
  if (Date.now() < memHub.nextCreateAt) return null;
  memHub.creating = (async () => {
    const r = await memUpstream(env, [{ operation: "createSession", variables: {} }], true, "createSession");
    memHub.stats.createSession++;
    if (r?.httpStatus === OK && r.data?.tk) {
      memHub.tk = r.data.tk;
      memHub.createdAt = Date.now();
      memHub.lastKeepAliveAt = Date.now();
      memHub.createBackoff = CREATE_BACKOFF_BASE_MS;
    } else {
      memHub.nextCreateAt = Date.now() + memHub.createBackoff;
      memHub.createBackoff = Math.min(memHub.createBackoff * 2, CREATE_BACKOFF_MAX_MS);
    }
    return memHub.tk;
  })().finally(() => {
    memHub.creating = null;
  });
  return memHub.creating;
}

async function memTouch(env) {
  memHub.stats.clientOps++;
  await memEnsure(env);
  if (!memHub.tk) return;
  const every = Math.max(memHub.config.pingIntervalMs, memHub.config.minPingIntervalMs);
  if (Date.now() - memHub.lastKeepAliveAt < every) return;
  memHub.lastKeepAliveAt = Date.now();
  const r = await memUpstream(env, [{ operation: "ping", variables: { tk: memHub.tk } }], false, "ping");
  memHub.stats.ping++;
  if (r?.httpStatus === SESSION_DEAD) memHub.tk = null;
}

async function memLyrics(env, id, bodyText) {
  let p = memHub.inflight.get(id);
  if (p) {
    memHub.stats.lyricsCoalesced++;
    return p;
  }
  memHub.stats.lyricsUpstream++;
  p = (async () => {
    const token = await getWebPlayerToken(env);
    const res = await fetch(`${API_ORIGIN}/query`, {
      method: "POST",
      headers: upstreamHeaders(env, token, false),
      body: bodyText,
    });
    memHub.lastUpstreamAt = Date.now();
    const contentType = res.headers.get("Content-Type") || "application/json";
    const buf = await res.arrayBuffer();
    if (isUpstreamBlock(res.status, contentType, buf)) {
      memNoteBlock(env, "lyrics", res.status);
      return blockedLyricsResult();
    }
    return { status: res.status, contentType, buf };
  })().finally(() => memHub.inflight.delete(id));
  memHub.inflight.set(id, p);
  return p;
}

// Route to the Durable Object when bound, otherwise to the in-isolate fallback.
function hub(env) {
  if (env && env.SESSION) {
    const stub = env.SESSION.get(env.SESSION.idFromName("shared"));
    return {
      touch: () => stub.fetch("https://hub/touch", { method: "POST" }),
      lyrics: (id, bodyText) =>
        stub.fetch("https://hub/lyrics", {
          method: "POST",
          headers: { "x-slp-id": id },
          body: bodyText,
        }),
      stats: () => stub.fetch("https://hub/stats"),
    };
  }
  return {
    touch: async () => {
      await memTouch(env);
      return Response.json({ ok: true });
    },
    lyrics: async (id, bodyText) => {
      const r = await memLyrics(env, id, bodyText);
      const h = { "Content-Type": r.contentType };
      if (r.blocked) h["X-Spicy-Upstream"] = "blocked";
      return new Response(r.buf, { status: r.status, headers: h });
    },
    stats: async () =>
      Response.json({
        mode: "isolate-fallback",
        sessionOpen: !!memHub.tk,
        sessionAgeSeconds: memHub.createdAt ? Math.round((Date.now() - memHub.createdAt) / 1000) : 0,
        lastUpstreamAt: memHub.lastUpstreamAt || null,
        upstreamBlocked: memHub.stats.blocked
          ? { count: memHub.stats.blocked, lastAt: memHub.lastBlockAt }
          : null,
        upstreamConfig: memHub.config,
        stats: memHub.stats,
      }),
  };
}

// --- Worker -----------------------------------------------------------------

// Same-isolate coalescing in front of the hub, so a burst from four devices in
// one colo does not even cross the DO boundary four times.
const edgeInflight = new Map(); // trackId -> Promise<{status, contentType, buf}>

export default {
  async fetch(request, env, ctx) {
    const log = makeLog(env, "proxy");
    const c = cfg(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const inUrl = new URL(request.url);
    const cors = corsHeaders(request);

    // Diagnostic: confirms token minting works without ever exposing the token.
    if (inUrl.pathname === "/__spicy/tokencheck") {
      if (!env || !env.SP_DC) return json({ ok: false, reason: "SP_DC not set" }, cors);
      cachedToken = null;
      const minted = await mintToken(env);
      return json(
        minted
          ? { ok: true, totpVer: minted.version }
          : { ok: false, reason: "minting failed (cookie expired or secret rotated)" },
        cors
      );
    }

    // Diagnostic: how much traffic actually reaches the Spicy Lyrics API.
    // `stats.clientOps` counts what devices asked for; `stats.ping` +
    // `stats.lyricsUpstream` count what we forwarded. The gap is the point.
    if (inUrl.pathname === "/__spicy/stats") {
      const res = await hub(env).stats();
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    const kind = body ? classify(body) : { type: "other" };

    // --- Session lifecycle: answered here, never forwarded per client. -------
    if (kind.type === "session") {
      // Fire-and-forget: the client's answer never waits on (or fails with) the
      // shared session's health.
      ctx.waitUntil(
        hub(env)
          .touch()
          .catch((err) => log("warn", "touch_failed", { error: String(err) }))
      );
      log("debug", "session_op_local", {
        ops: kind.queries.map((q) => q?.operation).join(","),
      });
      return json(sessionEnvelope(kind.queries, c), { ...cors, "X-Spicy-Session": "shared" });
    }

    // --- Lyrics: edge cache → in-isolate coalescing → shared hub. ------------
    if (kind.type === "lyrics") {
      const cache = caches.default;
      const cacheKey = new Request(`https://slcache.internal/lyrics/${kind.id}`, { method: "GET" });

      const hit = await cache.match(cacheKey);
      if (hit) {
        log("debug", "cache", { id: kind.id, state: "hit" });
        return new Response(await hit.arrayBuffer(), {
          status: 200,
          headers: {
            "Content-Type": hit.headers.get("Content-Type") || "application/json",
            "X-Spicy-Cache": "hit",
            ...cors,
          },
        });
      }

      const bodyText = new TextDecoder().decode(body);
      let shared = edgeInflight.get(kind.id);
      const coalesced = !!shared;
      if (!shared) {
        shared = (async () => {
          const res = await hub(env).lyrics(kind.id, bodyText);
          return {
            status: res.status,
            contentType: res.headers.get("Content-Type") || "application/json",
            blocked: res.headers.get("X-Spicy-Upstream") === "blocked",
            buf: await res.arrayBuffer(),
          };
        })().finally(() => edgeInflight.delete(kind.id));
        edgeInflight.set(kind.id, shared);
      }
      let r;
      try {
        r = await shared;
      } catch (err) {
        log("error", "hub_failed", { id: kind.id, error: String(err) });
        return json({ queries: [] }, { ...cors, "X-Spicy-Cache": "error" });
      }

      // Cache a found result for a long time; a definite "not found" briefly (so
      // a song without lyrics isn't re-queried every play). Never cache 503
      // (queued) or transient errors.
      const inner = innerStatus(r.buf);
      let ttl = 0;
      if (r.status === 200 && inner === 200) ttl = c.lyricsCacheTtl;
      else if (r.status === 200 && inner === 404) ttl = c.lyricsMissCacheTtl;
      if (ttl > 0) {
        ctx.waitUntil(
          cache.put(
            cacheKey,
            new Response(r.buf, {
              headers: { "Content-Type": r.contentType, "Cache-Control": `max-age=${ttl}` },
            })
          )
        );
      }

      log("info", "cache", {
        id: kind.id,
        state: coalesced ? "coalesced" : "miss",
        inner,
        ttl,
      });

      const outHeaders = {
        "Content-Type": r.contentType,
        "X-Spicy-Cache": coalesced ? "coalesced" : "miss",
        ...cors,
      };
      // Lets the page say "the API blocked this proxy" instead of "an error
      // occurred" — the two need very different reactions from the operator.
      if (r.blocked) outHeaders["X-Spicy-Upstream"] = "blocked";
      return new Response(r.buf, { status: r.status, headers: outHeaders });
    }

    // --- Everything else: plain passthrough with the shared identity. --------
    const token = await getWebPlayerToken(env);
    const headers = upstreamHeaders(env, token, false);
    if (!token) {
      const clientAuth = request.headers.get("SpicyLyrics-WebAuth");
      if (clientAuth) headers.set("SpicyLyrics-WebAuth", clientAuth);
    }
    headers.set("X-mode", request.headers.get("X-mode") || "2");

    const upstream = await fetch(API_ORIGIN + inUrl.pathname + inUrl.search, {
      method: request.method,
      headers,
      body,
    });
    log("info", "passthrough", { path: inUrl.pathname, http: upstream.status });

    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) respHeaders.set(k, v);
    return new Response(upstream.body, {
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
