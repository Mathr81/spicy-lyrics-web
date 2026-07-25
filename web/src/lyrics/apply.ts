// Dispatch a lyrics payload to the *real* Applyer, which builds the exact DOM +
// timing metadata the animator consumes.
import { ApplySyllableLyrics } from "@src/utils/Lyrics/Applyer/Synced/Syllable.ts";
import { ApplyLineLyrics } from "@src/utils/Lyrics/Applyer/Synced/Line.ts";
import { ApplyStaticLyrics } from "@src/utils/Lyrics/Applyer/Static.ts";
import { EmitNotApplyed } from "@src/utils/Lyrics/Applyer/OnApply.ts";
import { DestroyAllLyricsContainers } from "@src/utils/Lyrics/Applyer/CreateLyricsContainer.ts";
import { ClearLyricsContentArrays, setRomanizedStatus } from "@src/utils/Lyrics/lyrics.ts";
import { $currentLyricsType, $currentLyricsData } from "@src/utils/stores.ts";

export function applyLyrics(data: any, romanize: boolean): void {
  $currentLyricsData.set(JSON.stringify(data));
  $currentLyricsType.set(data.Type);
  setRomanizedStatus(romanize);

  if (data.Type === "Syllable") {
    ApplySyllableLyrics(data, romanize);
  } else if (data.Type === "Line") {
    ApplyLineLyrics(data, romanize);
  } else if (data.Type === "Static") {
    ApplyStaticLyrics(data, romanize);
  }
}

export function clearLyrics(): void {
  EmitNotApplyed();
  DestroyAllLyricsContainers();
  ClearLyricsContentArrays();
  $currentLyricsType.set("None");
  $currentLyricsData.set("");
}
