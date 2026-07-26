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
  type SimpleTrack,
  type RepeatMode,
} from "./api.ts";
import { pushPlaybackState, setPlaying } from "../shim/SpotifyPlayer.ts";

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

function emit(snap: AdapterSnapshot): void {
  last = snap;
  pushPlaybackState({
    positionMs: snap.positionMs,
    isPlaying: snap.isPlaying,
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
      const state = await sdkPlayer.getCurrentState();
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
    }, 1000);
  });
}

// ---------------------------------------------------------------------------
// Spotify Connect mirror (polling)
// ---------------------------------------------------------------------------
function startConnectPolling(): void {
  const poll = async () => {
    try {
      const snap = await getPlaybackState();
      if (snap) {
        emit({
          track: snap.track,
          isPlaying: snap.isPlaying,
          positionMs: snap.progressMs,
          deviceName: snap.deviceName,
          mode: "connect",
          shuffle: snap.shuffle,
          repeat: snap.repeat,
        });
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
  };
  void poll();
  connectTimer = window.setInterval(poll, 1000);
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

export async function play(uri: string): Promise<void> {
  if (mode === "sdk" && sdkDeviceId) {
    await apiPlayTrack(uri, sdkDeviceId);
  } else {
    await apiPlayTrack(uri);
  }
}

export async function togglePlay(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) {
    await sdkPlayer.togglePlay();
    return;
  }
  if (last.isPlaying) await apiPause();
  else await apiResume();
}

export async function seekTo(positionMs: number): Promise<void> {
  if (mode === "sdk" && sdkPlayer) {
    await sdkPlayer.seek(positionMs);
  } else {
    await apiSeek(positionMs);
  }
  // Optimistic re-anchor for instant lyric response.
  emit({ ...last, positionMs });
}

export async function skipNext(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) await sdkPlayer.nextTrack();
  else await apiNext();
}

export async function skipPrev(): Promise<void> {
  if (mode === "sdk" && sdkPlayer) await sdkPlayer.previousTrack();
  else await apiPrevious();
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
  (window as any).__spicyPause = () => void (mode === "sdk" ? sdkPlayer?.pause() : apiPause());
  (window as any).__spicyPlay = () => void (mode === "sdk" ? sdkPlayer?.resume() : apiResume());
  (window as any).__spicyToggle = () => void togglePlay();
  (window as any).__spicyNext = () => void skipNext();
  (window as any).__spicyPrev = () => void skipPrev();
  void setPlaying; // keep import referenced if unused paths are tree-shaken
}
