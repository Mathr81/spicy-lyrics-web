// Spicy Lyrics API session keep-alive.
//
// Since v6.2.3 the API uses a session model: a client is expected to call
// `createSession` (→ a session token) and keep it alive with periodic `ping`s,
// refreshing before the session TTL expires; `pingConfig` returns the intervals
// to use. Traffic that doesn't maintain a session gets rate-limited — which is
// what made lyrics fail intermittently here (the standalone never opened one).
//
// This mirrors the extension's SessionManager (utils/SessionManager) but is
// self-contained and defensive: every failure is non-fatal and simply retried
// with backoff, and lyric fetching works regardless of session state. The
// session-creating ops (`createSession`/`refreshSession`) are authorized by the
// `Authorization` header, which a browser can't set — the bundled Worker proxy
// injects it (see web/proxy/worker.js), so this only establishes a real session
// when LYRICS_API points at that proxy. Without it the calls fail harmlessly.
import { LYRICS_API, CLIENT_VERSION } from "../config.ts";
import { getAccessToken } from "../spotify/auth.ts";

interface PingConfig {
  pingIntervalMs: number;
  minPingIntervalMs: number;
  sessionTtlSeconds: number;
  refreshAtTtlFraction: number;
}

interface OpResult {
  data: any;
  httpStatus: number;
}

const DEFAULT_CONFIG: PingConfig = {
  pingIntervalMs: 300000,
  minPingIntervalMs: 240000,
  sessionTtlSeconds: 3600,
  refreshAtTtlFraction: 0.8,
};

const STATUS = { OK: 200, SESSION_DEAD: 403 } as const;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const PING_JITTER_MS = 2000;

let config: PingConfig = { ...DEFAULT_CONFIG };
let tk: string | null = null;
let started = false;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let createBackoff = BACKOFF_BASE_MS;

async function query(
  queries: Array<{ operation: string; variables?: any }>,
  extraHeaders: Record<string, string> = {}
): Promise<OpResult | null> {
  try {
    const res = await fetch(`${LYRICS_API}/query`, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        "SpicyLyrics-Version": CLIENT_VERSION,
        "X-mode": "2",
        ...extraHeaders,
      },
      body: JSON.stringify({ queries, client: { version: CLIENT_VERSION } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result =
      json?.queries?.find((q: any) => q.operationId === "0")?.result ??
      json?.queries?.[0]?.result;
    return result ?? null;
  } catch {
    return null;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  // The Worker prefers its own SP_DC web-player token and injects Authorization
  // for session ops; passing WebAuth too covers direct-API setups.
  return token ? { "SpicyLyrics-WebAuth": `Bearer ${token}` } : {};
}

function applyPingConfig(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const num = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  if (num(d.pingIntervalMs)) config.pingIntervalMs = d.pingIntervalMs;
  if (num(d.minPingIntervalMs)) config.minPingIntervalMs = d.minPingIntervalMs;
  if (num(d.sessionTtlSeconds)) config.sessionTtlSeconds = d.sessionTtlSeconds;
  if (num(d.refreshAtTtlFraction) && (d.refreshAtTtlFraction as number) <= 1)
    config.refreshAtTtlFraction = d.refreshAtTtlFraction;
}

const pingDelay = () =>
  Math.max(config.pingIntervalMs, config.minPingIntervalMs) +
  Math.random() * PING_JITTER_MS;
const refreshDelay = () =>
  config.sessionTtlSeconds * 1000 * config.refreshAtTtlFraction;

async function syncPingConfig(): Promise<void> {
  const r = await query([{ operation: "pingConfig", variables: {} }]);
  if (r?.httpStatus === STATUS.OK) applyPingConfig(r.data);
}

function scheduleTimers(): void {
  if (pingTimer) clearTimeout(pingTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  pingTimer = setTimeout(() => void pingTick(), pingDelay());
  refreshTimer = setTimeout(() => void refreshTick(), refreshDelay());
}

async function pingTick(): Promise<void> {
  if (!tk) return;
  const r = await query([{ operation: "ping", variables: { tk } }]);
  if (r?.httpStatus === STATUS.SESSION_DEAD) {
    recover();
    return;
  }
  pingTimer = setTimeout(() => void pingTick(), pingDelay());
}

async function refreshTick(): Promise<void> {
  if (!tk) return;
  await syncPingConfig();
  const r = await query(
    [{ operation: "refreshSession", variables: { tk } }],
    await authHeader()
  );
  if (r?.httpStatus === STATUS.OK && r.data?.tk) {
    tk = r.data.tk;
    refreshTimer = setTimeout(() => void refreshTick(), refreshDelay());
    return;
  }
  if (r?.httpStatus === STATUS.SESSION_DEAD) {
    recover();
    return;
  }
  refreshTimer = setTimeout(() => void refreshTick(), BACKOFF_BASE_MS);
}

function recover(): void {
  tk = null;
  if (pingTimer) clearTimeout(pingTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  setTimeout(() => void createLoop(), BACKOFF_BASE_MS);
}

async function createLoop(): Promise<void> {
  while (!tk) {
    await syncPingConfig();
    const r = await query(
      [{ operation: "createSession", variables: {} }],
      await authHeader()
    );
    if (r?.httpStatus === STATUS.OK && r.data?.tk) {
      tk = r.data.tk;
      createBackoff = BACKOFF_BASE_MS;
      scheduleTimers();
      return;
    }
    const delay = createBackoff;
    createBackoff = Math.min(createBackoff * 2, BACKOFF_MAX_MS);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Open and maintain an API session in the background. Idempotent. */
export function initSession(): void {
  if (started) return;
  started = true;
  void createLoop();
}
