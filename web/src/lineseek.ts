// Tap (or click) a lyric line to jump playback to it.
//
// The extension does this in `utils/Lyrics/lyrics.ts` (addLinesEvListener),
// but that is wired from its PageView, which the web build replaces — and its
// handler only matches a syllable line when the tap lands on a word, not on the
// line's own padding. This one resolves any tap inside a line to that line.
//
// The target also accounts for the sync offset: a line is shown at
// `StartTime + offset` of the audio, so that is where playback must land for
// the line to be the active one straight away.
import { LyricsObject } from "@src/utils/Lyrics/lyrics.ts";
import { $playbackOffset, $seekFadeCompensation } from "@src/utils/stores.ts";
import Global from "@src/components/Global/Global.ts";
import { SpotifyPlayer } from "./shim/SpotifyPlayer.ts";

// Same value as the extension: Spotify fades audio in after a seek, which
// swallows a fast line's first syllable when landing exactly on it.
const SEEK_FADE_COMPENSATION_MS = 300;

interface TimedLine {
  HTMLElement: HTMLElement;
  StartTime: number;
  Syllables?: { Lead: { StartTime: number }[] };
}

function startOf(lineEl: HTMLElement): number | null {
  const lines: TimedLine[] = [
    ...LyricsObject.Types.Syllable.Lines,
    ...LyricsObject.Types.Line.Lines,
  ];
  const line = lines.find((l) => l.HTMLElement === lineEl);
  if (!line) return null;
  return line.Syllables?.Lead?.[0]?.StartTime ?? line.StartTime;
}

export function enableLineSeek(content: HTMLElement): void {
  content.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest("a, button, .SongInfo, .Credits")) return;
    // Selecting text to copy it is not a request to seek.
    if (window.getSelection()?.toString()) return;

    const lineEl = target.closest<HTMLElement>(".line");
    if (!lineEl || !content.contains(lineEl)) return;

    const start = startOf(lineEl);
    if (start === null) return; // static lyrics, or an interlude dot line

    const fade = $seekFadeCompensation.get() ? SEEK_FADE_COMPENSATION_MS : 0;
    const position = Math.max(0, start + $playbackOffset.get() - fade);
    SpotifyPlayer.Seek(position);
    Global.Event.evoke("song:seek", position);
  });
}
