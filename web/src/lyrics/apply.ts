// Dispatch a lyrics payload to the *real* Applyer, which builds the exact DOM +
// timing metadata the animator consumes — or, when the Apple Music view is
// chosen in Settings, to that view instead (lyrics/apple.ts).
import { ApplySyllableLyrics } from "@src/utils/Lyrics/Applyer/Synced/Syllable.ts";
import { ApplyLineLyrics } from "@src/utils/Lyrics/Applyer/Synced/Line.ts";
import { ApplyStaticLyrics } from "@src/utils/Lyrics/Applyer/Static.ts";
import { EmitNotApplyed } from "@src/utils/Lyrics/Applyer/OnApply.ts";
import { DestroyAllLyricsContainers } from "@src/utils/Lyrics/Applyer/CreateLyricsContainer.ts";
import { ClearLyricsContentArrays, setRomanizedStatus } from "@src/utils/Lyrics/lyrics.ts";
import { $currentLyricsType, $currentLyricsData, persistAtom } from "@src/utils/stores.ts";
import { PageContainer } from "../shim/PageView.ts";
import { SpotifyPlayer } from "../shim/SpotifyPlayer.ts";
import type * as AppleView from "./apple.ts";

/** Settings → "Affichage Apple Music". Off = the Spicy Lyrics renderer. */
export const $appleLyrics = persistAtom<boolean>("web:appleLyrics", false);

// Set once the Apple Music view's chunk has loaded; until then there is nothing
// of it on screen to hide.
let appleView: typeof AppleView | null = null;
const loadAppleView = () => import("./apple.ts").then((view) => (appleView = view));
let last: { data: any; romanize: boolean } | null = null;

function clearSpicy(): void {
  EmitNotApplyed();
  DestroyAllLyricsContainers();
  ClearLyricsContentArrays();
}

function applySpicy(data: any, romanize: boolean): void {
  appleView?.hideAppleLyrics();
  if (data.Type === "Syllable") {
    ApplySyllableLyrics(data, romanize);
  } else if (data.Type === "Line") {
    ApplyLineLyrics(data, romanize);
  } else if (data.Type === "Static") {
    ApplyStaticLyrics(data, romanize);
  }
}

export function applyLyrics(data: any, romanize: boolean): void {
  last = { data, romanize };
  $currentLyricsData.set(JSON.stringify(data));
  $currentLyricsType.set(data.Type);
  setRomanizedStatus(romanize);

  // Unsynced lyrics have no timings for the Apple Music view to animate; they
  // stay on the Spicy renderer in both modes.
  if (!$appleLyrics.get() || data.Type === "Static") {
    applySpicy(data, romanize);
    return;
  }

  clearSpicy();
  void loadAppleView()
    .then((view) => {
      // The track, the romanization or the setting may have changed meanwhile.
      if (last?.data !== data || last.romanize !== romanize || !$appleLyrics.get()) return;
      if (!view.showAppleLyrics(data, romanize)) applySpicy(data, romanize);
    })
    .catch((err) => {
      console.error("[SpicyLyrics] Apple Music view failed to load", err);
      if (last?.data === data) applySpicy(data, romanize);
    });
}

export function clearLyrics(): void {
  last = null;
  appleView?.hideAppleLyrics();
  clearSpicy();
  $currentLyricsType.set("None");
  $currentLyricsData.set("");
}

/**
 * The page-level half of the setting: the class the Apple Music styling keys on
 * and the background. Called whenever the setting or the cover changes.
 */
export function syncAppleChrome(): void {
  const on = $appleLyrics.get();
  PageContainer?.classList.toggle("sl-apple", on);
  if (!on) {
    appleView?.setAppleBackground(null);
    return;
  }
  void loadAppleView()
    .then((view) => {
      if ($appleLyrics.get()) view.setAppleBackground(SpotifyPlayer.GetCover("large") ?? null);
    })
    .catch((err) => console.error("[SpicyLyrics] Apple Music view failed to load", err));
}

// Switching views re-renders the lyrics already on screen.
$appleLyrics.listen(() => {
  syncAppleChrome();
  if (last) applyLyrics(last.data, last.romanize);
});
