// Spicy Lyrics payload → AMLL's line model, for the Apple Music view (apple.ts).
// Kept free of DOM and engine imports so it can be tested on its own.
import type { LyricLine, LyricWord } from "@applemusic-like-lyrics/core";

// The API's times are in seconds, AMLL's in milliseconds. AMLL rejects a line or
// word that ends before it starts, so the end is clamped.
const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

function toWords(syllables: any[], romanize: boolean): LyricWord[] {
  const out: LyricWord[] = [];
  syllables.forEach((s, i) => {
    const startTime = ms(s.StartTime);
    const endTime = Math.max(startTime, ms(s.EndTime));
    out.push({
      word: String(s.Text ?? ""),
      startTime,
      endTime,
      romanWord: romanize ? (s.TransliteratedText ?? "") : "",
    });
    // AMLL models the gap between two words as a zero-length word of its own.
    if (!s.IsPartOfWord && i < syllables.length - 1) {
      out.push({ word: " ", startTime: endTime, endTime });
    }
  });
  return out;
}

export function toLines(data: any, romanize: boolean): LyricLine[] {
  const lines: LyricLine[] = [];
  const push = (
    words: LyricWord[],
    timed: { StartTime: number; EndTime: number },
    isBG: boolean,
    isDuet: boolean,
    romanLyric = ""
  ) => {
    if (!words.some((w) => w.word.trim())) return;
    const startTime = ms(timed.StartTime);
    lines.push({
      words,
      startTime,
      endTime: Math.max(startTime, ms(timed.EndTime)),
      isBG,
      isDuet,
      translatedLyric: "",
      romanLyric,
    });
  };

  for (const l of Array.isArray(data.Content) ? data.Content : []) {
    const isDuet = l?.OppositeAligned === true;
    if (data.Type === "Syllable") {
      if (!Array.isArray(l?.Lead?.Syllables)) continue;
      push(toWords(l.Lead.Syllables, romanize), l.Lead, false, isDuet);
      for (const bg of Array.isArray(l.Background) ? l.Background : []) {
        if (Array.isArray(bg?.Syllables)) push(toWords(bg.Syllables, romanize), bg, true, isDuet);
      }
    } else if (data.Type === "Line") {
      const startTime = ms(l.StartTime);
      const word = { word: String(l.Text ?? ""), startTime, endTime: Math.max(startTime, ms(l.EndTime)) };
      push([word], l, false, isDuet, romanize ? (l.TransliteratedText ?? "") : "");
    }
  }
  return lines;
}
