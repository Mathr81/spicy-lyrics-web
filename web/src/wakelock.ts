// Screen Wake Lock — keep the display on while lyrics are playing.
//
// Without this, an iPad showing lyrics dims and locks after ~30 s: the page has
// no video element, and Spotify's own audio may be playing on a different
// device entirely (Connect mirror mode), so iOS sees an idle Safari tab.
//
// Supported in Safari 16.4+ (iOS/iPadOS 16.4, March 2023) and every current
// Chromium. Where it isn't, this module is a silent no-op.
//
// Two things make a naive `request()` unreliable in practice:
//
//  - The lock is dropped by the system whenever the document becomes hidden
//    (app switch, screen off, tab change) and is NOT restored automatically, so
//    it has to be re-acquired on `visibilitychange`.
//  - A request while the document is hidden rejects with NotAllowedError, so
//    the desired state is tracked separately from the actual lock and
//    reconciled whenever either changes.

const STORE_KEY = "sl_wakelock_enabled_v1";

type Sentinel = { released: boolean; release: () => Promise<void> } & EventTarget;

let sentinel: Sentinel | null = null;
let wantLock = false; // "something is playing"
let enabled = readEnabled(); // user preference
let acquiring = false;
let listening = false;

export function wakeLockSupported(): boolean {
  return "wakeLock" in navigator;
}

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function isWakeLockEnabled(): boolean {
  return enabled;
}

/** User preference (Settings → "Garder l'écran allumé"). */
export function setWakeLockEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(STORE_KEY, value ? "1" : "0");
  } catch {
    /* storage unavailable — the preference just won't persist */
  }
  void reconcile();
}

/** Called from the playback snapshot: hold the screen awake while playing. */
export function setPlaying(playing: boolean): void {
  if (wantLock === playing) return;
  wantLock = playing;
  void reconcile();
}

async function acquire(): Promise<void> {
  if (sentinel || acquiring || document.visibilityState !== "visible") return;
  acquiring = true;
  try {
    const s = (await (navigator as any).wakeLock.request("screen")) as Sentinel;
    sentinel = s;
    // The system released it (screen off, low battery, tab hidden). Forget it so
    // the next reconcile re-acquires instead of assuming we still hold one.
    s.addEventListener("release", () => {
      if (sentinel === s) sentinel = null;
    });
  } catch {
    // NotAllowedError (hidden document) or the feature being unavailable —
    // either way there is nothing to do but try again on the next transition.
  } finally {
    acquiring = false;
  }
}

async function release(): Promise<void> {
  const s = sentinel;
  sentinel = null;
  if (!s || s.released) return;
  try {
    await s.release();
  } catch {
    /* already gone */
  }
}

async function reconcile(): Promise<void> {
  if (!wakeLockSupported()) return;
  if (enabled && wantLock) await acquire();
  else await release();
}

/**
 * Start managing the screen wake lock. Idempotent; safe to call where the API
 * is unsupported.
 */
export function initWakeLock(): void {
  if (!wakeLockSupported() || listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    // Coming back to the foreground: the lock we held is gone, re-take it.
    void reconcile();
  });
  void reconcile();
}
