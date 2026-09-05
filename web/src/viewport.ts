// iOS / iPadOS standalone (PWA) viewport correction.
//
// The "black bar at the bottom" on an installed iPad PWA:
//
// `apple-mobile-web-app-status-bar-style: black-translucent` (+ `viewport-fit=
// cover`) asks iOS to draw the web view *under* the status bar, which is why the
// page starts at the physical top edge of the screen. But iOS keeps the layout
// viewport at the height it would have had BELOW the status bar — the document
// is effectively shifted up by the top inset, and the strip it no longer covers
// at the bottom is painted with the manifest's `background_color` (black).
//
// So `position: fixed; inset: 0` — which is how the whole page is anchored —
// resolves to a box that is `safe-area-inset-top` px too short. The fix is to
// grow the fixed host by exactly that deficit; everything else follows.
//
// We measure the deficit rather than trusting `env(safe-area-inset-top)` alone,
// because in standalone mode there is no browser chrome, so
// `screen height - window.innerHeight` IS the missing strip — and it stays
// correct if Apple ever changes the inset. `env()` is kept as the CSS fallback
// for the first paint (before this module runs) and if the measurement looks
// implausible.

const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);

// Anything larger than this is not a status bar — refuse to "fix" it.
const MAX_PLAUSIBLE_GAP_PX = 64;

function isStandalone(): boolean {
  // `navigator.standalone` is the only reliable signal on iOS home-screen apps;
  // the display-mode queries cover iPadOS 17+ and any future alignment.
  return (
    (navigator as any).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches
  );
}

// The screen's height in CSS pixels for the CURRENT orientation. iOS is
// inconsistent about whether `screen.width`/`screen.height` swap on rotation,
// so derive it from the orientation instead of reading `screen.height` blindly.
function screenHeight(): number {
  const landscape = window.matchMedia("(orientation: landscape)").matches;
  const a = window.screen.width;
  const b = window.screen.height;
  return landscape ? Math.min(a, b) : Math.max(a, b);
}

function measure(): void {
  const gap = Math.round(screenHeight() - window.innerHeight);
  const root = document.documentElement;
  if (gap > 0 && gap <= MAX_PLAUSIBLE_GAP_PX) {
    root.style.setProperty("--sl-viewport-gap", `${gap}px`);
  } else {
    // Implausible (rotation mid-measure, Stage Manager window, split view):
    // drop back to the CSS `env()` fallback rather than inventing a number.
    root.style.removeProperty("--sl-viewport-gap");
  }
}

/**
 * Tag the document so the standalone-only CSS applies, and keep the measured
 * viewport deficit up to date. No-op outside an installed iOS/iPadOS PWA.
 */
export function initViewport(): void {
  if (!IS_IOS || !isStandalone()) return;
  document.documentElement.classList.add("sl-ios-standalone");
  measure();

  // Rotation and Stage Manager resizes change the inset; iOS also reports stale
  // dimensions for a frame or two after `orientationchange`, hence the retry.
  const remeasure = () => {
    measure();
    setTimeout(measure, 250);
  };
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", remeasure);
  window.visualViewport?.addEventListener("resize", measure);
}
