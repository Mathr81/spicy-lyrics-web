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
// resolves to a box that is `safe-area-inset-top` px too short. styles.css grows
// the fixed host by that inset, and everything else follows.
//
// That is full screen. A window that is not the whole screen (Split View, Slide
// Over, a Stage Manager window) has nothing missing: grown by the inset all the
// same, its bottom — the Apple Music transport — ran off the screen. This module
// tells the two apart and turns the correction off in a window.
//
// It does so from the WIDTH. Nothing here may read the height: `innerHeight`
// follows the page, so a page grown by the status bar reports the full screen,
// which reads exactly like "nothing missing". Acting on that removed the
// correction, which brought the gap back, which restored the correction — the
// black bar flickering at the bottom of the screen.

const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);

function isStandalone(): boolean {
  // `navigator.standalone` is the only reliable signal on iOS home-screen apps;
  // the display-mode queries cover iPadOS 17+ and any future alignment.
  return (
    (navigator as any).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches
  );
}

/**
 * Whether the page is in a window narrower than the screen.
 *
 * Full screen, the width is one of the screen's two sides — either one, so that
 * a rotation, during which iOS reports the old width against the new
 * orientation, never reads as a window.
 */
export function isWindowed(screenA: number, screenB: number, innerWidth: number): boolean {
  return Math.abs(innerWidth - screenA) > 1 && Math.abs(innerWidth - screenB) > 1;
}

function apply(): void {
  const root = document.documentElement;
  if (isWindowed(window.screen.width, window.screen.height, window.innerWidth)) {
    root.style.setProperty("--sl-viewport-gap", "0px");
  } else {
    // Full screen: the stylesheet's own `env(safe-area-inset-top)`.
    root.style.removeProperty("--sl-viewport-gap");
  }
}

/**
 * Tag the document so the standalone-only CSS applies, and keep the correction
 * off while the page is in a window. No-op outside an installed iOS/iPadOS PWA.
 */
export function initViewport(): void {
  if (!IS_IOS || !isStandalone()) return;
  document.documentElement.classList.add("sl-ios-standalone");
  apply();
  window.addEventListener("resize", apply);
}
