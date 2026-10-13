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

// Which way the DEVICE is held. Not the `(orientation: landscape)` media query:
// that one describes the viewport, and a Split View pane on a landscape iPad is
// taller than it is wide.
function deviceIsLandscape(): boolean {
  const type = window.screen.orientation?.type;
  if (type) return type.startsWith("landscape");
  const angle = (window as any).orientation;
  if (typeof angle === "number") return Math.abs(angle) === 90;
  return window.matchMedia("(orientation: landscape)").matches;
}

/**
 * The strip missing under the page, in px, or null when it can't be told. iOS is
 * inconsistent about whether `screen.width`/`screen.height` swap on rotation, so
 * the screen's height comes from the orientation.
 *
 * 0 is an answer, not a failed measurement: a Split View pane has nothing
 * missing, and growing it by the `env()` fallback pushed the bottom of the page
 * (the Apple Music transport) off the screen.
 */
export function viewportGap(
  screenA: number,
  screenB: number,
  landscape: boolean,
  innerHeight: number
): number | null {
  const screenHeight = landscape ? Math.min(screenA, screenB) : Math.max(screenA, screenB);
  const gap = Math.round(screenHeight - innerHeight);
  return gap >= 0 && gap <= MAX_PLAUSIBLE_GAP_PX ? gap : null;
}

function measure(): void {
  const gap = viewportGap(
    window.screen.width,
    window.screen.height,
    deviceIsLandscape(),
    window.innerHeight
  );
  const root = document.documentElement;
  if (gap !== null) {
    root.style.setProperty("--sl-viewport-gap", `${gap}px`);
  } else {
    // Implausible (rotation mid-measure, a window shorter than the screen):
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

  // Rotation and Stage Manager resizes change the inset; iOS also reports stale
  // dimensions for a frame or two at launch and after `orientationchange`, hence
  // the retry.
  const remeasure = () => {
    measure();
    setTimeout(measure, 250);
  };
  remeasure();
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", remeasure);
  window.visualViewport?.addEventListener("resize", measure);
}
