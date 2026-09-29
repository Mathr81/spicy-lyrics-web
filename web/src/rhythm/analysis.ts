// Rhythm data for the dynamic background, in the shape of Spotify's audio
// analysis (`AudioAnalysisData`), which BackgroundAnimationController reads.
//
// Spotify withdrew /v1/audio-analysis for apps registered after 2024-11-27, so
// most deployments get a 403. The chain, first answer wins:
//
//   1. Spotify /v1/audio-analysis — only for apps that still have it. The first
//      403 switches it off for the session.
//   2. AcousticBrainz — per-beat timestamps (Essentia's beat tracker), reached
//      through the track's ISRC → MusicBrainz recording ids. Gives the beat
//      pulse. Only accepted when the analysed file's length matches Spotify's
//      duration (see DURATION_TOLERANCE_S): another edit or master would put
//      every pulse off the beat, which is worse than no pulse. The dataset is
//      frozen since 2022, so recent releases are not in it.
//   3. ReccoBeats — track-level tempo and loudness only: the warp gets the
//      song's own pace, without a pulse.
//
// Tempo/loudness come from ReccoBeats whenever it knows the track (it reports
// loudness in dB, as Spotify did; AcousticBrainz does not), otherwise from
// AcousticBrainz's BPM and a typical loudness.
//
// Every result — a miss included — is persisted per track, so a song costs its
// lookups once per device, not once per play.
import type { AudioAnalysisData } from "@src/components/DynamicBG/BackgroundAnimationController.ts";
import { getAudioAnalysis, getTrackIdentity } from "../spotify/api.ts";

export type RhythmSource = "spotify" | "acousticbrainz" | "reccobeats";

export interface Rhythm {
  source: RhythmSource;
  data: AudioAnalysisData;
}

const MUSICBRAINZ = "https://musicbrainz.org/ws/2";
const ACOUSTICBRAINZ = "https://acousticbrainz.org/api/v1";
const RECCOBEATS = "https://api.reccobeats.com/v1";

// Beats are timestamps into the file AcousticBrainz analysed. Past this much
// length difference it is likely another edit/master and the grid would drift.
const DURATION_TOLERANCE_S = 2;
// Each candidate costs a full low-level document (~55 KB: the API's
// `features=` filter cannot select `beats_position`), so only the few closest
// in length are fetched.
const MAX_CANDIDATES = 3;
// AcousticBrainz has no per-beat confidence. The controller scales the pulse
// by it and ignores beats under 0.4; this sits in the middle of what Spotify's
// beats typically carried.
const BEAT_CONFIDENCE = 0.6;
// A typical modern master, for when no source reports loudness in dB.
const DEFAULT_LOUDNESS_DB = -8;
// MusicBrainz allows one request per second per client.
const MUSICBRAINZ_SPACING_MS = 1100;
const MUSICBRAINZ_RETRY_MS = 2500;

const TRACK_ID = /^[A-Za-z0-9]{22}$/;

const STORE_PREFIX = "sl_rhythm_v1_";
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

// Compact persisted form — beat times rather than full Beat objects.
interface Stored {
  source?: RhythmSource;
  tempo?: number;
  loudness?: number;
  duration?: number;
  beats?: number[];
  /** Spotify's own analysis, stored as-is. */
  spotify?: AudioAnalysisData;
  /** Set on a miss; retried after MISS_TTL_MS. */
  missAt?: number;
}

function readStored(trackId: string): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + trackId);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function writeStored(trackId: string, value: Stored): void {
  try {
    localStorage.setItem(STORE_PREFIX + trackId, JSON.stringify(value));
  } catch {
    /* quota or storage unavailable — the in-memory cache still serves */
  }
}

function toAnalysis(s: Stored): AudioAnalysisData {
  if (s.spotify) return s.spotify;
  const times = s.beats ?? [];
  const beats = times.map((start, i) => {
    const next = times[i + 1];
    const duration = next !== undefined ? next - start : i > 0 ? start - times[i - 1] : 0.5;
    return { start, duration, confidence: BEAT_CONFIDENCE };
  });
  return {
    track: {
      tempo: s.tempo ?? 120,
      loudness: s.loudness ?? DEFAULT_LOUDNESS_DB,
      duration: s.duration ?? 0,
    },
    // No sections: the controller then uses the track-level tempo/loudness.
    sections: [],
    beats,
    segments: [],
  };
}

function fromStored(s: Stored): Rhythm | null {
  if (!s.source) return null;
  return { source: s.source, data: toAnalysis(s) };
}

// --- sources -----------------------------------------------------------------

let spotifyAnalysisAvailable = true;

async function fromSpotify(trackId: string): Promise<Stored | null> {
  if (!spotifyAnalysisAvailable) return null;
  try {
    const result = await getAudioAnalysis(trackId);
    if (result.status === "unavailable") {
      // Withdrawn per app, not per track — nothing else will succeed either.
      spotifyAnalysisAvailable = false;
      return null;
    }
    if (result.status === "ok") {
      return { source: "spotify", spotify: result.data as AudioAnalysisData };
    }
  } catch {
    /* transient — fall through to the other sources */
  }
  return null;
}

let musicBrainzQueue: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One MusicBrainz lookup. Its rate limiter answers 503 without CORS headers,
 * which a browser surfaces as a network error, so any failure gets one retry
 * after a pause before counting as "not found".
 */
async function musicBrainzJson(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(MUSICBRAINZ_RETRY_MS);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) return await res.json();
      if (res.status !== 503) return null;
    } catch {
      /* rate-limited or offline — retry once */
    }
  }
  return null;
}

/** MusicBrainz recording ids for an ISRC, closest in length first. */
function recordingsForIsrc(isrc: string, durationS: number): Promise<string[]> {
  // Serialised and spaced, per MusicBrainz's rate limit.
  const run = musicBrainzQueue.then(async () => {
    try {
      const json = await musicBrainzJson(`${MUSICBRAINZ}/isrc/${encodeURIComponent(isrc)}?fmt=json`);
      const recordings: { id: string; length?: number | null }[] = json?.recordings ?? [];
      return recordings
        .map((r) => ({ id: r.id, gap: r.length ? Math.abs(r.length / 1000 - durationS) : Infinity }))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, MAX_CANDIDATES)
        .map((r) => r.id);
    } finally {
      await sleep(MUSICBRAINZ_SPACING_MS);
    }
  });
  musicBrainzQueue = run.catch(() => undefined);
  return run.catch(() => []);
}

async function fromAcousticBrainz(
  isrc: string,
  durationS: number
): Promise<{ beats: number[]; bpm: number; duration: number } | null> {
  const ids = await recordingsForIsrc(isrc, durationS);
  if (ids.length === 0) return null;

  const res = await fetch(`${ACOUSTICBRAINZ}/low-level?recording_ids=${ids.join(";")}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = await res.json();

  let best: { beats: number[]; bpm: number; duration: number; gap: number } | null = null;
  for (const id of ids) {
    // The bulk endpoint returns each recording's first submission (one
    // analysed file); iterate in case it ever returns more.
    for (const doc of Object.values<any>(json?.[id] ?? {})) {
      const beats: unknown = doc?.rhythm?.beats_position;
      const length = Number(doc?.metadata?.audio_properties?.length);
      if (!Array.isArray(beats) || beats.length < 8 || !Number.isFinite(length)) continue;
      const gap = Math.abs(length - durationS);
      if (gap > DURATION_TOLERANCE_S || (best && gap >= best.gap)) continue;
      best = { beats: beats.map(Number), bpm: Number(doc?.rhythm?.bpm) || 0, duration: length, gap };
    }
  }
  return best ? { beats: best.beats, bpm: best.bpm, duration: best.duration } : null;
}

async function fromReccoBeats(trackId: string): Promise<{ tempo: number; loudness: number } | null> {
  const res = await fetch(`${RECCOBEATS}/audio-features?ids=${trackId}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const hit = (json?.content ?? []).find(
    (c: any) => typeof c?.href === "string" && c.href.endsWith(`/${trackId}`)
  );
  if (!hit || !Number.isFinite(hit.tempo) || !Number.isFinite(hit.loudness)) return null;
  return { tempo: hit.tempo, loudness: hit.loudness };
}

async function resolve(trackId: string): Promise<Stored | null> {
  const spotify = await fromSpotify(trackId);
  if (spotify) return spotify;

  const [identity, recco] = await Promise.all([
    getTrackIdentity(trackId).catch(() => null),
    fromReccoBeats(trackId).catch(() => null),
  ]);
  const durationS = (identity?.durationMs ?? 0) / 1000;

  const ab =
    identity?.isrc && durationS > 0
      ? await fromAcousticBrainz(identity.isrc, durationS).catch(() => null)
      : null;

  if (ab) {
    return {
      source: "acousticbrainz",
      beats: ab.beats,
      duration: ab.duration,
      tempo: recco?.tempo ?? ab.bpm,
      loudness: recco?.loudness,
    };
  }
  if (recco) {
    return { source: "reccobeats", tempo: recco.tempo, loudness: recco.loudness, duration: durationS };
  }
  return null;
}

// --- public API --------------------------------------------------------------

const memory = new Map<string, Rhythm | null>();
const inflight = new Map<string, Promise<Rhythm | null>>();

/**
 * The rhythm data for a track, or null when no source has any. Cached in
 * memory and in localStorage; concurrent callers share one lookup.
 */
export function getRhythm(trackId: string): Promise<Rhythm | null> {
  if (!TRACK_ID.test(trackId)) return Promise.resolve(null);
  if (memory.has(trackId)) return Promise.resolve(memory.get(trackId)!);

  const stored = readStored(trackId);
  if (stored && (!stored.missAt || Date.now() - stored.missAt < MISS_TTL_MS)) {
    const rhythm = fromStored(stored);
    memory.set(trackId, rhythm);
    return Promise.resolve(rhythm);
  }

  let p = inflight.get(trackId);
  if (!p) {
    p = resolve(trackId)
      .then((found) => {
        writeStored(trackId, found ?? { missAt: Date.now() });
        const rhythm = found ? fromStored(found) : null;
        memory.set(trackId, rhythm);
        console.info(
          `[SpicyLyrics] background rhythm for ${trackId}: ` +
            (rhythm ? `${rhythm.source} (${rhythm.data.beats.length} beats)` : "none")
        );
        return rhythm;
      })
      .catch(() => {
        // Unexpected failure: don't persist, but don't retry this session.
        memory.set(trackId, null);
        return null;
      })
      .finally(() => inflight.delete(trackId));
    inflight.set(trackId, p);
  }
  return p;
}
