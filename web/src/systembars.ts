// Android system bars.
//
// An installed app on Android is not drawn under the status bar or the gesture
// bar. Chrome paints both in a flat colour it takes from the page — the
// `theme-color` meta for the status bar; for the strip behind the gesture pill,
// reports differ between that same colour and the page background — and here
// both were a fixed black: two black bands around an album-coloured page.
//
// So both follow the background instead: its top edge goes to `theme-color`,
// its bottom edge to the page background, re-read as the background flows. The
// bands are still there, in the colour of what they sit against.
//
// Android only: iOS draws the page under its status bar already (viewport.ts),
// and on a desktop this would tint the installed app's title bar.
import { PageContainer } from "./shim/PageView.ts";

const PERIOD_MS = 1000;
const MAX_TRIES = 10;
// Each edge is read as a strip of the background this tall (a share of its
// height), centred on the edge and averaged across the width: a bar has one
// colour, an edge of the background several, and both backgrounds darken
// towards their rims, so a strip reaching further in reads too bright.
const STRIP = 0.04;
const COLS = 8;

export function initSystemBars(): void {
  if (!/Android/i.test(navigator.userAgent)) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const probe = document.createElement("canvas");
  probe.width = COLS;
  probe.height = 2; // top edge, bottom edge
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!meta || !ctx) return;

  /** False when the background could not be read this frame and is worth retrying. */
  const read = (): boolean => {
    const page = PageContainer;
    // Whichever background is on screen: Apple Music's, or the Spicy one.
    const backgrounds = page?.querySelectorAll<HTMLCanvasElement>(
      "canvas.sl-amll-bg, canvas.spicy-dynamic-bg"
    );
    const bg = Array.from(backgrounds ?? []).find((c) => c.offsetParent !== null);
    if (!page || !bg || !bg.width || !bg.height) return true;

    // The Spicy background is shown through a CSS filter (saturate, brightness);
    // the bars have to match what is seen, not what is in the canvas. A blur
    // changes no colour and would only smear a probe this small.
    const filter = getComputedStyle(bg).filter.replace(/blur\([^)]*\)/g, "").trim();
    ctx.filter = filter || "none";
    ctx.clearRect(0, 0, COLS, 2);

    // Where the page's edges fall in the canvas: the Apple Music one overscans
    // the page, so its own first and last rows are off screen.
    const box = bg.getBoundingClientRect();
    const view = page.getBoundingClientRect();
    const height = Math.max(1, Math.round(bg.height * STRIP));
    [view.top, view.bottom].forEach((edge, i) => {
      const centre = ((edge - box.top) / box.height) * bg.height;
      const y = Math.min(bg.height - height, Math.max(0, Math.round(centre - height / 2)));
      ctx.drawImage(bg, 0, y, bg.width, height, 0, i, COLS, 1);
    });
    const px = ctx.getImageData(0, 0, COLS, 2).data;

    // A row's colour over the page's black, which is what a translucent pixel
    // shows against. Null for a row with nothing in it: a WebGL canvas reads
    // back empty unless it drew during this very frame.
    const row = (y: number): string | null => {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let i = y * COLS * 4; i < (y + 1) * COLS * 4; i += 4) {
        const a = px[i + 3] / 255;
        r += px[i] * a;
        g += px[i + 1] * a;
        b += px[i + 2] * a;
        alpha += a;
      }
      if (alpha === 0) return null;
      return `rgb(${Math.round(r / COLS)}, ${Math.round(g / COLS)}, ${Math.round(b / COLS)})`;
    };
    const top = row(0);
    const bottom = row(1);
    if (!top || !bottom) return false;

    meta.content = top;
    document.documentElement.style.backgroundColor = bottom;
    document.body.style.backgroundColor = bottom;
    return true;
  };

  let tries = 0;
  const tick = () => {
    if (!read() && ++tries < MAX_TRIES) {
      requestAnimationFrame(tick);
      return;
    }
    tries = 0;
    // From a timer, so this lands after the frame callbacks the backgrounds
    // already queued: they have drawn by the time it reads.
    setTimeout(() => requestAnimationFrame(tick), PERIOD_MS);
  };
  tick();
}
