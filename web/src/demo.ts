// Offline demo mode (?demo) — drives the real rendering engine with a built-in
// sample so the page can be previewed without a Spotify login. Also doubles as
// a smoke test for the faithful lyric animation.
import { pushPlaybackState } from "./shim/SpotifyPlayer.ts";
import { applyLyrics } from "./lyrics/apply.ts";
import { updateNowBar } from "./renderer.ts";

const SAMPLE = {
  Type: "Syllable",
  StartTime: 0.5,
  Content: [
    {
      OppositeAligned: false,
      Lead: {
        StartTime: 0.5,
        EndTime: 3.2,
        Syllables: [
          { Text: "This", StartTime: 0.5, EndTime: 0.9 },
          { Text: "is", StartTime: 0.95, EndTime: 1.3 },
          { Text: "Spicy", StartTime: 1.35, EndTime: 2.0 },
          { Text: "Lyrics", StartTime: 2.05, EndTime: 3.2 },
        ],
      },
    },
    {
      OppositeAligned: false,
      Lead: {
        StartTime: 3.6,
        EndTime: 7.0,
        Syllables: [
          { Text: "run", StartTime: 3.6, EndTime: 4.0 },
          { Text: "ning", StartTime: 4.0, EndTime: 4.4, IsPartOfWord: true },
          { Text: "in", StartTime: 4.5, EndTime: 4.9 },
          { Text: "your", StartTime: 4.95, EndTime: 5.4 },
          { Text: "brow", StartTime: 5.5, EndTime: 6.1 },
          { Text: "ser", StartTime: 6.1, EndTime: 7.0, IsPartOfWord: true },
        ],
      },
    },
    {
      OppositeAligned: false,
      Lead: {
        StartTime: 7.4,
        EndTime: 11.0,
        Syllables: [
          { Text: "no", StartTime: 7.4, EndTime: 7.9 },
          { Text: "Spotify", StartTime: 8.0, EndTime: 8.9 },
          { Text: "app", StartTime: 9.0, EndTime: 9.6 },
          { Text: "required", StartTime: 9.7, EndTime: 11.0 },
        ],
      },
    },
  ],
  HasTransliterations: false,
  uri: "spotify:track:demo",
};

const LOOP_MS = 12_000;

export function startDemo(): void {
  const track = {
    uri: "spotify:track:demo",
    id: "demo",
    name: "Demo Song",
    artists: [{ name: "Spicy Lyrics", uri: "", type: "artist" as const }],
    cover: "https://images.spikerko.org/SongPlaceholderFull.png",
    durationMs: LOOP_MS,
  };

  updateNowBar(track);
  pushPlaybackState({ positionMs: 0, isPlaying: true, track });
  applyLyrics(SAMPLE, false);

  // Re-anchor the clock each loop so the sample repeats.
  const start = performance.now();
  setInterval(() => {
    const pos = (performance.now() - start) % LOOP_MS;
    pushPlaybackState({ positionMs: pos, isPlaying: true });
  }, 500);
}
