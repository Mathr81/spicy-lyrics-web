// Browser shim for `src/components/Global/SpotifyPlayer.ts`.
//
// The real module reads everything from `window.Spicetify.Player`. Here we keep
// a small mutable state object that the Spotify adapter (spotify/player.ts)
// pushes into, and expose the exact same `SpotifyPlayer` surface the rendering
// engine consumes. The only thing the animator actually reads every frame is
// `GetPosition()` (milliseconds).
//
// That one number is the lyric clock, and it is read ~60x a second from a source
// that is sampled at best once a second, asynchronously, over the network. What
// keeps it honest is in `GetProgress()` below and mirrors the extension's
// `src/utils/Gets/GetProgress.ts`: extrapolate on the local monotonic clock,
// anchor each sample at the moment it was actually true rather than the moment
// it arrived, hold the anchor through a source that has stopped refreshing, and
// low-pass the remaining jitter instead of snapping to it.
import { $playbackOffset } from "@src/utils/stores.ts";

export type CoverSizes = "standard" | "small" | "large" | "xlarge";
export type Artist = { type: "artist"; name: string; uri: string };

export interface TrackState {
  uri: string | null;
  id: string | null;
  name: string | null;
  artists: Artist[];
  cover: string | null; // https URL
  durationMs: number;
}

const EMPTY_TRACK: TrackState = {
  uri: null,
  id: null,
  name: null,
  artists: [],
  cover: null,
  durationMs: 0,
};

const state = {
  track: { ...EMPTY_TRACK },
  isPlaying: false,
  // Position clock anchor: the track was at `anchorMs` when the monotonic clock
  // read `anchorAt`. Both live on `performance.now()`, which — unlike Date.now()
  // — cannot be stepped by an NTP correction mid-song.
  anchorMs: 0,
  anchorAt: performance.now(),
  // The last position the source reported, to recognise one that has stopped
  // refreshing. See pushPlaybackState.
  lastReportedMs: null as number | null,
};

// --- Position smoothing (a trimmed port of GetProgress.normalizeProgress) ---
// Deltas within this window are treated as jitter and smoothed; anything larger
// is a real seek or track change and snaps immediately.
const JITTER_RESYNC_THRESHOLD = 500;
// Low-pass time constant (ms), applied as alpha = 1 - exp(-elapsed / TAU) so the
// smoothing is frame-rate independent. A proportional pull rather than a
// deadband, so there is no steady-state offset: it cancels divergence without
// ever adding lag, because the clock itself advances on real time.
const JITTER_TIME_CONSTANT = 300;
// Forward lead (ms) applied while playing, compensating for the audio output
// latency between "the player is at position X" and the sound reaching the ear.
// The extension's PROGRESS_POSITION_OFFSET, same value. A perceptual dial, not a
// correctness value — $playbackOffset is the per-setup one on top of it.
const POSITION_LEAD_MS = 100;
let predicted: { id: string | null; pos: number; at: number } | null = null;

function clampToTrack(pos: number): number {
  const d = state.track.durationMs;
  let c = Math.max(0, pos);
  if (d > 0) c = Math.min(c, d);
  return c;
}

/** Called by the adapter whenever a fresh authoritative position is known. */
export function pushPlaybackState(next: {
  positionMs: number;
  isPlaying: boolean;
  track?: Partial<TrackState>;
  /**
   * When this sample was actually true, on the `performance.now()` timeline.
   *
   * Reading playback state is asynchronous, and in Connect mirror mode it is a
   * network round trip: `positionMs` describes a moment that has already passed
   * by the time it gets here. Anchoring it at arrival would leave the clock late
   * by the full round trip — a fixed, invisible lag of anywhere from 50ms on
   * wifi to several hundred on cellular. Callers pass the request/response
   * midpoint. Omitting it falls back to now, which is only correct for a source
   * that answers synchronously.
   */
  sampledAt?: number;
}): void {
  const sampledAt = next.sampledAt ?? performance.now();
  const wasPlaying = state.isPlaying;

  let trackChanged = false;
  if (next.track) {
    trackChanged = !!(next.track.uri && next.track.uri !== state.track.uri);
    state.track = { ...state.track, ...next.track };
    if (trackChanged) predicted = null;
  }

  // A source handing back the position it gave last time has not refreshed:
  // /me/player reports the remote device's last known state, which can easily
  // repeat between two one-second polls. Re-anchoring on a repeat would rewind
  // the clock by a whole poll interval, and the jitter filter — seeing a delta
  // far past its threshold — would read that as a seek and snap backwards. Hold
  // the anchor instead and keep extrapolating through the gap, the way
  // GetProgress holds its anchor across a stalling getPositionState.
  const sourceStalled =
    !trackChanged &&
    wasPlaying &&
    next.isPlaying &&
    state.lastReportedMs !== null &&
    next.positionMs === state.lastReportedMs;

  state.lastReportedMs = next.positionMs;
  state.isPlaying = next.isPlaying;
  if (sourceStalled) return;

  state.anchorMs = next.positionMs;
  state.anchorAt = sampledAt;
}

export function setPlaying(isPlaying: boolean): void {
  // Re-anchor at the current extrapolated position so the clock doesn't jump.
  state.anchorMs = rawPosition();
  state.anchorAt = performance.now();
  state.isPlaying = isPlaying;
  // The next sample is authoritative whatever it says: a pause/resume is exactly
  // when a repeated position is genuine rather than a stalled source.
  state.lastReportedMs = null;
}

function rawPosition(): number {
  if (!state.isPlaying) return state.anchorMs;
  return state.anchorMs + (performance.now() - state.anchorAt);
}

function normalize(pos: number): number {
  const id = state.track.id;
  const measured = clampToTrack(pos);
  const now = performance.now();
  if (!predicted || predicted.id !== id || !state.isPlaying) {
    predicted = { id, pos: measured, at: now };
    return measured;
  }
  const elapsed = Math.max(0, now - predicted.at);
  let p = predicted.pos + elapsed;
  const error = measured - p;
  if (Math.abs(error) > JITTER_RESYNC_THRESHOLD) {
    p = measured;
  } else {
    const alpha = 1 - Math.exp(-elapsed / JITTER_TIME_CONSTANT);
    p += error * alpha;
  }
  p = clampToTrack(p);
  predicted = { id, pos: p, at: now };
  return p;
}

function GetProgress(): number {
  // Mirrors GetProgress.ts's final assembly. The user offset applies in both
  // states so the active line doesn't jump when playback pauses; the audio
  // latency lead only applies while sound is actually coming out. Its sign reads
  // the way the setting is described: negative runs the lyrics early, positive
  // holds them back.
  const offset = $playbackOffset.get();
  const raw = rawPosition();
  return normalize(state.isPlaying ? raw + POSITION_LEAD_MS - offset : raw - offset);
}

export const SpotifyPlayer = {
  IsPlaying: false,
  _DEPRECATED_: { GetTrackPosition: GetProgress },
  GetPosition: GetProgress,
  GetContentType: (): string => "track",
  GetMediaType: (): string => "audio",
  GetDuration: (): number => state.track.durationMs,
  Seek: (_position: number): void => {
    // Wired by the adapter via window hook to avoid a circular import.
    (window as any).__spicySeek?.(_position);
  },
  GetCover: (_size: CoverSizes): string | undefined =>
    state.track.cover ?? "https://images.spikerko.org/SongPlaceholderFull.png",
  GetCoverFrom: (
    _size: CoverSizes,
    source: Array<{ url: string; label: string }>
  ): string | undefined => source?.[0]?.url,
  GetName: (): string | undefined => state.track.name ?? undefined,
  GetShowName: (): string | undefined => undefined,
  GetAlbumName: (): string | undefined => undefined,
  GetId: (): string | undefined => state.track.id ?? undefined,
  GetArtists: (): Artist[] | undefined => state.track.artists,
  GetUri: (): string | undefined => state.track.uri ?? undefined,
  Pause: () => (window as any).__spicyPause?.(),
  Play: () => (window as any).__spicyPlay?.(),
  TogglePlayState: () => (window as any).__spicyToggle?.(),
  Skip: {
    Next: () => (window as any).__spicyNext?.(),
    Prev: () => (window as any).__spicyPrev?.(),
  },
  LoopType: "none",
  ShuffleType: "none",
  IsDJ: (): boolean => false,
  IsLiked: () => false,
  ToggleLike: async () => {},
  // The engine only constructs Playbar buttons in app.tsx (not reused), so a
  // stub keeps any stray reference from throwing.
  Playbar: {
    Button: class {
      element = document.createElement("button");
      register() {}
      deregister() {}
    },
    Widget: class {
      element = document.createElement("button");
      register() {}
      deregister() {}
    },
  },
};

export function getTrackState(): TrackState {
  return state.track;
}

/**
 * Whether playback is running right now.
 *
 * Reads the shim's own state rather than the playback adapter's, so it is also
 * correct under `?demo`, which drives `pushPlaybackState` directly and never
 * starts an adapter.
 */
export function isPlaying(): boolean {
  return state.isPlaying;
}
