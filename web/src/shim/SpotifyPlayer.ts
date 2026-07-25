// Browser shim for `src/components/Global/SpotifyPlayer.ts`.
//
// The real module reads everything from `window.Spicetify.Player`. Here we keep
// a small mutable state object that the Spotify adapter (spotify/player.ts)
// pushes into, and expose the exact same `SpotifyPlayer` surface the rendering
// engine consumes. The only thing the animator actually reads every frame is
// `GetPosition()` (milliseconds).

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
  // Position clock anchor.
  anchorMs: 0,
  anchorAt: performance.now(),
};

// --- Position smoothing (a trimmed port of GetProgress.normalizeProgress) ---
const JITTER_RESYNC_THRESHOLD = 500;
const JITTER_TIME_CONSTANT = 300;
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
}): void {
  if (next.track) {
    const changedTrack = next.track.uri && next.track.uri !== state.track.uri;
    state.track = { ...state.track, ...next.track };
    if (changedTrack) predicted = null;
  }
  state.isPlaying = next.isPlaying;
  state.anchorMs = next.positionMs;
  state.anchorAt = performance.now();
}

export function setPlaying(isPlaying: boolean): void {
  // Re-anchor at the current extrapolated position so the clock doesn't jump.
  state.anchorMs = rawPosition();
  state.anchorAt = performance.now();
  state.isPlaying = isPlaying;
}

function rawPosition(): number {
  if (!state.isPlaying) return state.anchorMs;
  return state.anchorMs + (performance.now() - state.anchorAt);
}

function normalize(pos: number): number {
  const id = state.track.id;
  const measured = clampToTrack(pos);
  const now = Date.now();
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
  return normalize(rawPosition());
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
