// Unified playback adapter.
//
// Two backends behind one interface:
//  - "sdk"      : Spotify Web Playback SDK — plays audio in this tab (desktop).
//  - "connect"  : mirrors whatever device is playing via GET /me/player polling
//                 (the only option that works on iPad/iOS Safari).
//
// Both feed the same `SpotifyPlayer` shim state (position + track), which the
// reused rendering engine reads every animation frame.
import { SDK_SUPPORTED } from "../config.ts";
import { getAccessToken } from "./auth.ts";
import {
  getPlaybackState,
  transferPlayback,
  playTrack as apiPlayTrack,
  pause as apiPause,
  resume as apiResume,
  seek as apiSeek,
  next as apiNext,
  previous as apiPrevious,
  setShuffle as apiSetShuffle,
  setRepeat as apiSetRepeat,
  addToQueue as apiAddToQueue,
  type SimpleTrack,
  type RepeatMode,
} from "./api.ts";
import { pushPlaybackState, setPlaying } from "../shim/SpotifyPlayer.ts";
import { shell, type NativeSession } from "../native.ts";

export type PlaybackMode = "sdk" | "connect";

export interface AdapterSnapshot {
  track: SimpleTrack | null;
  isPlaying: boolean;
  positionMs: number;
  deviceName: string | null;
  mode: PlaybackMode;
  shuffle: boolean;
  repeat: RepeatMode;
}

type UpdateListener = (snap: AdapterSnapshot) => void;

let mode: PlaybackMode = "connect";
let sdkAttemptedAndFailed = false;
let sdkPlayer: any = null;
let sdkDeviceId: string | null = null;

export function didSdkFail(): boolean {
  return sdkAttemptedAndFailed;
}
let connectTimer: number | null = null;
// The device the mirror last saw, kept once Spotify stops reporting one: play
// has to name it then (see api.ts resume).
let lastDeviceId: string | null = null;
// A play/pause sent from here shows at once; until this time, polls that still
// say otherwise are Spotify catching up, not news.
let intentUntil = 0;
const INTENT_HOLD_MS = 2000;
const errorListeners = new Set<(message: string) => void>();
let sdkPollTimer: number | null = null;
const listeners = new Set<UpdateListener>();
let last: AdapterSnapshot = {
  track: null,
  isPlaying: false,
  positionMs: 0,
  deviceName: null,
  mode: "connect",
  shuffle: false,
  repeat: "off",
};

function repeatFromMode(m: number | undefined): RepeatMode {
  return m === 2 ? "track" : m === 1 ? "context" : "off";
}

export function onUpdate(cb: UpdateListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A play/pause Spotify did not take, as a sentence for the user. */
export function onPlaybackError(cb: (message: string) => void): void {
  errorListeners.add(cb);
}

export function getMode(): PlaybackMode {
  return mode;
}

export function getSnapshot(): AdapterSnapshot {
  return last;
}

export function isPlaying(): boolean {
  return last.isPlaying;
}

export function getSdkDeviceId(): string | null {
  return sdkDeviceId;
}

/**
 * `sampledAt` is when `snap.positionMs` was true, on the `performance.now()`
 * timeline — see `sampleMidpoint`. It is deliberately not part of
 * AdapterSnapshot: only the lyric clock cares, UI listeners don't.
 */
function emit(snap: AdapterSnapshot, sampledAt?: number): void {
  last = snap;
  pushPlaybackState({
    positionMs: snap.positionMs,
    isPlaying: snap.isPlaying,
    sampledAt,
    track: snap.track
      ? {
          uri: snap.track.uri,
          id: snap.track.id,
          name: snap.track.name,
          artists: snap.track.artists,
          cover: snap.track.cover,
          durationMs: snap.track.durationMs,
        }
      : undefined,
  });
  for (const l of listeners) l(snap);
}

/**
 * The NTP-style midpoint of a state read: the value came back describing some
 * instant between the request leaving and the response arriving, and with no
 * further information the midpoint is the least-biased estimate of which.
 *
 * Anchoring at arrival instead — which is what happens when this is omitted —
 * makes the lyric clock late by the whole round trip, every single sample.
 */
function sampleMidpoint(startedAt: number): number {
  return startedAt + (performance.now() - startedAt) / 2;
}

// ---------------------------------------------------------------------------
// Web Playback SDK
// ---------------------------------------------------------------------------
function loadSdkScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Spotify?.Player) return resolve();
    (window as any).onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Spotify Web Playback SDK"));
    document.head.appendChild(script);
  });
}

function sdkTrackToSimple(t: any): SimpleTrack | null {
  if (!t) return null;
  return {
    uri: t.uri,
    id: t.id ?? (t.uri?.split(":")[2] ?? ""),
    name: t.name,
    artists: (t.artists ?? []).map((a: any) => ({
      name: a.name,
      uri: a.uri,
      type: "artist" as const,
    })),
    cover: t.album?.images?.[0]?.url ?? null,
    durationMs: t.duration_ms ?? 0,
  };
}

async function initSdk(): Promise<boolean> {
  await loadSdkScript();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // If the SDK can't reach Spotify's realtime "dealer" WebSocket (commonly
    // blocked by ad/privacy blockers) neither `ready` nor an error event fires,
    // so cap the wait and fall back to Connect mirror mode.
    const timeout = window.setTimeout(() => finish(false), 9000);

    const Spotify = (window as any).Spotify;
    sdkPlayer = new Spotify.Player({
      name: "Spicy Lyrics (Web)",
      getOAuthToken: (cb: (t: string) => void) => {
        void getAccessToken().then((t) => cb(t ?? ""));
      },
      volume: 0.8,
    });

    sdkPlayer.addListener("ready", ({ device_id }: { device_id: string }) => {
      sdkDeviceId = device_id;
      window.clearTimeout(timeout);
      finish(true);
    });
    sdkPlayer.addListener("not_ready", () => {
      /* device went offline */
    });
    sdkPlayer.addListener("initialization_error", () => {
      window.clearTimeout(timeout);
      finish(false);
    });
    sdkPlayer.addListener("authentication_error", () => {
      window.clearTimeout(timeout);
      finish(false);
    });
    sdkPlayer.addListener("account_error", () => {
      window.clearTimeout(timeout);
      finish(false);
    });

    sdkPlayer.addListener("player_state_changed", (state: any) => {
      if (!state) return;
      emit({
        track: sdkTrackToSimple(state.track_window?.current_track),
        isPlaying: !state.paused,
        positionMs: state.position ?? 0,
        deviceName: "This browser",
        mode: "sdk",
        shuffle: !!state.shuffle,
        repeat: repeatFromMode(state.repeat_mode),
      });
    });

    void sdkPlayer.connect();

    // Re-anchor position periodically so the clock stays tight during long lines.
    sdkPollTimer = window.setInterval(async () => {
      const startedAt = performance.now();
      const state = await sdkPlayer.getCurrentState();
      if (!state) return;
      emit(
        {
          track: sdkTrackToSimple(state.track_window?.current_track),
          isPlaying: !state.paused,
          positionMs: state.position ?? 0,
          deviceName: "This browser",
          mode: "sdk",
          shuffle: !!state.shuffle,
          repeat: repeatFromMode(state.repeat_mode),
        },
        sampleMidpoint(startedAt)
      );
    }, 1000);
  });
}

// ---------------------------------------------------------------------------
// Spotify Connect mirror (polling)
// ---------------------------------------------------------------------------
async function pollMirror(): Promise<void> {
  try {
    const startedAt = performance.now();
    const snap = await getPlaybackState();
    if (snap?.deviceId) lastDeviceId = snap.deviceId;
    const clock = snap && sessionClock(snap.track);
    if (
      !clock &&
      performance.now() < intentUntil &&
      (snap?.isPlaying ?? false) !== last.isPlaying
    ) {
      return;
    }
    if (snap) {
      emit(
        {
          track: snap.track,
          isPlaying: snap.isPlaying,
          positionMs: snap.progressMs,
          deviceName: snap.deviceName,
          mode: "connect",
          shuffle: snap.shuffle,
          repeat: snap.repeat,
          ...clock,
        },
        clock ? undefined : sampleMidpoint(startedAt)
      );
    } else if (last.track) {
      // No active device: Spotify drops it a while after a pause. The track
      // stays up, paused where it was, rather than the page going blank.
      if (last.isPlaying) emit({ ...last, isPlaying: false });
    } else {
      emit({
        track: null,
        isPlaying: false,
        positionMs: 0,
        deviceName: null,
        mode: "connect",
        shuffle: false,
        repeat: "off",
      });
    }
  } catch (err) {
    console.warn("[SpicyLyrics] playback poll failed", err);
  }
}

function startConnectPolling(): void {
  void pollMirror();
  connectTimer = window.setInterval(pollMirror, 1000);
  linkNativeSession();
}

// ---------------------------------------------------------------------------
// Android app: Spotify's own media session, on the same phone
// ---------------------------------------------------------------------------
// The shell (native.ts) reports the session the moment it changes, where the
// Web API is a network round trip a second: so the session is the clock and the
// transport, and the polling above is only still needed to say WHICH track is
// playing — the session has a title, not a Spotify id.
let session: (NativeSession & { at: number }) | null = null;

/** Play state and position from the session, when it is on `track`. */
function sessionClock(
  track: SimpleTrack | null
): Pick<AdapterSnapshot, "isPlaying" | "positionMs"> | null {
  if (!session || session.title !== track?.name) return null;
  const elapsed = session.playing ? performance.now() - session.at : 0;
  return { isPlaying: session.playing, positionMs: session.positionMs + elapsed };
}

function linkNativeSession(): void {
  (window as any).__spicyNative = (next: NativeSession | null) => {
    session = next && { ...next, at: performance.now() };
    const clock = sessionClock(last.track);
    if (clock) emit({ ...last, ...clock });
    // Another title: ask the Web API which track that is, now.
    else if (session) void pollMirror();
  };
  shell?.subscribe?.();
}

/** Through the session when there is one; false sends the caller to the Web API. */
function sessionTransport(
  action: "play" | "pause" | "next" | "prev" | "seek",
  positionMs = 0
): boolean {
  return !!session && !!shell?.transport?.(action, positionMs);
}

// ---------------------------------------------------------------------------
// Public control surface
// ---------------------------------------------------------------------------
export async function initPlayer(preferSdk: boolean): Promise<PlaybackMode> {
  if (preferSdk && SDK_SUPPORTED) {
    try {
      const ok = await initSdk();
      if (ok) {
        mode = "sdk";
        // Move playback to this browser device so audio plays here.
        if (sdkDeviceId) {
          try {
            await transferPlayback(sdkDeviceId, false);
          } catch {
            /* user can start playback manually */
          }
        }
        wireControlHooks();
        return mode;
      }
      sdkAttemptedAndFailed = true;
    } catch (err) {
      sdkAttemptedAndFailed = true;
      console.warn("[SpicyLyrics] SDK init failed, falling back to Connect", err);
    }
  }
  mode = "connect";
  startConnectPolling();
  wireControlHooks();
  return mode;
}

const targetDevice = () => (mode === "sdk" ? sdkDeviceId : lastDeviceId);

/** Play this track now. Throws when Spotify refuses. */
export async function play(uri: string): Promise<void> {
  await apiPlayTrack(uri, targetDevice());
}

/** Add this track to the queue. Throws when Spotify refuses. */
export async function queueTrack(uri: string): Promise<void> {
  await apiAddToQueue(uri, targetDevice());
}

export async function togglePlay(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) {
    await sdkPlayer.togglePlay();
    return;
  }
  await setMirrorPlaying(!last.isPlaying);
}

/** Connect mirror: play or pause the remote device. */
async function setMirrorPlaying(playing: boolean): Promise<void> {
  if (sessionTransport(playing ? "play" : "pause")) return;
  const show = (v: boolean) => {
    setPlaying(v); // keeps the lyric clock where it is, unlike emit()
    last = { ...last, isPlaying: v };
    for (const l of listeners) l(last);
  };
  show(playing);
  intentUntil = performance.now() + INTENT_HOLD_MS;
  try {
    await (playing ? apiResume(lastDeviceId) : apiPause());
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 403: Spotify was already in that state.
    if (status === 403) return;
    intentUntil = 0;
    show(!playing);
    const message =
      status === 404
        ? `Spotify ne répond plus sur « ${last.deviceName ?? "l'appareil"} ». Ouvre l'app Spotify pour relancer.`
        : `Spotify n'a pas pris la commande (${status ?? "réseau"}).`;
    for (const l of errorListeners) l(message);
  }
}

export async function seekTo(positionMs: number): Promise<void> {
  if (mode === "sdk" && sdkPlayer) {
    await sdkPlayer.seek(positionMs);
  } else if (!sessionTransport("seek", positionMs)) {
    await apiSeek(positionMs);
  }
  // Optimistic re-anchor for instant lyric response.
  emit({ ...last, positionMs });
}

export async function skipNext(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) await sdkPlayer.nextTrack();
  else if (!sessionTransport("next")) await apiNext();
}

export async function skipPrev(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) await sdkPlayer.previousTrack();
  else if (!sessionTransport("prev")) await apiPrevious();
}

/**
 * Opt-in: take over playback in this browser tab via the Web Playback SDK.
 * Not done automatically on load — the page mirrors the active device by
 * default and only becomes its own player when the user asks.
 */
export async function enableSdkPlayback(): Promise<boolean> {
  if (mode === "sdk") return true;
  if (!SDK_SUPPORTED) return false;
  try {
    const ok = await initSdk();
    if (!ok) {
      sdkAttemptedAndFailed = true;
      return false;
    }
    mode = "sdk";
    if (connectTimer) {
      clearInterval(connectTimer);
      connectTimer = null;
    }
    if (sdkDeviceId) {
      try {
        await transferPlayback(sdkDeviceId, true);
      } catch {
        /* nothing was playing to move */
      }
    }
    wireControlHooks();
    return true;
  } catch {
    sdkAttemptedAndFailed = true;
    return false;
  }
}

export async function toggleShuffle(): Promise<void> {
  const next = !last.shuffle;
  emit({ ...last, shuffle: next }); // optimistic
  try {
    await apiSetShuffle(next);
  } catch (err) {
    console.warn("[SpicyLyrics] shuffle toggle failed", err);
  }
}

export async function cycleRepeat(): Promise<void> {
  const order: RepeatMode[] = ["off", "context", "track"];
  const next = order[(order.indexOf(last.repeat) + 1) % order.length];
  emit({ ...last, repeat: next }); // optimistic
  try {
    await apiSetRepeat(next);
  } catch (err) {
    console.warn("[SpicyLyrics] repeat cycle failed", err);
  }
}

function wireControlHooks(): void {
  (window as any).__spicySeek = (ms: number) => void seekTo(ms);
  (window as any).__spicyPause = () =>
    void (mode === "sdk" ? sdkPlayer?.pause() : setMirrorPlaying(false));
  (window as any).__spicyPlay = () =>
    void (mode === "sdk" ? sdkPlayer?.resume() : setMirrorPlaying(true));
  (window as any).__spicyToggle = () => void togglePlay();
  (window as any).__spicyNext = () => void skipNext();
  (window as any).__spicyPrev = () => void skipPrev();
}
