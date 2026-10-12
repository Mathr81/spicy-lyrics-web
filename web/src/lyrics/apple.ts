// Apple Music-style view — the alternative to the Spicy renderer, chosen in
// Settings. The rendering itself is AMLL's (@applemusic-like-lyrics/core): this
// module only converts the Spicy Lyrics payload to AMLL's line model, feeds it
// the same playback clock the Spicy animator reads, and places it the way
// AMLL's own Apple Music player does (react-full's horizontal/vertical layouts,
// the source of the alignment below and of the metrics in styles.css).
//
// Loaded on demand (see apply.ts), so the default Spicy view doesn't pay for it.
import {
  BackgroundRender,
  LayoutAlignAnchor,
  LyricPlayer,
  MeshGradientRenderer,
  type LyricLineMouseEvent,
} from "@applemusic-like-lyrics/core";
// The stand-in for San Francisco where the system doesn't have it. Declared
// after -apple-system in the font stack, so Apple devices never download it.
import "@fontsource-variable/inter/wght.css";
import { PageContainer } from "../shim/PageView.ts";
import { SpotifyPlayer, isPlaying } from "../shim/SpotifyPlayer.ts";
import { KawarpMap } from "../shim/dynamicBackground.ts";
import { seekToLyricTime } from "../lineseek.ts";
import { toLines } from "./amll-lines.ts";

export { mountAppleTransport } from "./apple-transport.ts";

const PAGE_CLASS = "sl-apple-lyrics";
// The clock's jitter filter (shim/SpotifyPlayer.ts) treats anything under this
// as noise; so do we.
const JITTER_MS = 500;

let player: LyricPlayer | null = null;
let raf = 0;
let lastFrame = 0;
let lastPos = 0;
let wasPlaying: boolean | null = null;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  if (!player) return;

  let pos = SpotifyPlayer.GetPosition();
  // The jitter filter can step the clock back a few ms, and AMLL reads any step
  // back as a seek (lines snap instead of springing). Hold instead.
  if (pos < lastPos && lastPos - pos < JITTER_MS) pos = lastPos;
  lastPos = pos;

  const playing = isPlaying();
  if (playing !== wasPlaying) {
    wasPlaying = playing;
    if (playing) player.resume();
    else player.pause();
  }

  player.setCurrentTime(pos);
  player.update(now - lastFrame);
  lastFrame = now;
}

/**
 * Where the active line sits. Beside the cover, it is level with the cover's
 * centre; stacked under the header (compact layout), it is near the top.
 */
function align(): void {
  const page = PageContainer;
  if (!player || !page) return;
  const box = player.getElement().getBoundingClientRect();
  const cover = page.querySelector<HTMLElement>(".NowBar .MediaBox")?.getBoundingClientRect();
  if (!cover || !box.height || page.classList.contains("CompactMode")) {
    player.setAlignAnchor(LayoutAlignAnchor.Top);
    player.setAlignPosition(0.1);
    return;
  }
  player.setAlignAnchor(LayoutAlignAnchor.Center);
  player.setAlignPosition((cover.top + cover.height / 2 - box.top) / box.height);
}

/**
 * Show `data` in the Apple Music view. Returns false when it can't (unsynced
 * lyrics, nothing renderable, or AMLL refusing the timings) so the caller falls
 * back to the Spicy renderer.
 */
export function showAppleLyrics(data: any, romanize: boolean): boolean {
  const page = PageContainer;
  const host = page?.querySelector<HTMLElement>(".LyricsContainer");
  if (!page || !host) return false;

  const lines = toLines(data, romanize);
  if (!lines.length) return false;

  if (!player) {
    player = new LyricPlayer();
    const el = player.getElement();
    el.classList.add("sl-amll");
    player.addEventListener("line-click", (e) => {
      seekToLyricTime((e as LyricLineMouseEvent).line.getLine().startTime);
    });
    // Covers every layout change: window, compact mode, cover side.
    new ResizeObserver(align).observe(el);
  }

  // Attached before the lines are set, so AMLL measures them at their real size.
  host.appendChild(player.getElement());
  page.classList.add(PAGE_CLASS);
  // AMLL read its font size when the player was built, detached — NaN — and
  // times the word wipe from it. Have it measure again now that it can.
  player.onResize();
  align();

  lastPos = SpotifyPlayer.GetPosition();
  try {
    player.setLyricLines(lines, lastPos);
  } catch (err) {
    console.warn("[SpicyLyrics] Apple Music view rejected these lyrics", err);
    hideAppleLyrics();
    return false;
  }

  const writers: string[] = Array.isArray(data.SongWriters) ? data.SongWriters : [];
  player.getBottomLineElement().textContent = writers.length
    ? `Écrit par : ${writers.join(", ")}`
    : "";

  if (!raf) {
    lastFrame = performance.now();
    wasPlaying = null;
    raf = requestAnimationFrame(frame);
  }
  return true;
}

export function hideAppleLyrics(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  // Emptied first: detaching fires AMLL's resize handling, which would otherwise
  // rebuild every word's animation against a zero-sized, unmeasurable player.
  player?.setLyricLines([]);
  player?.getElement().remove();
  PageContainer?.classList.remove(PAGE_CLASS);
}

let background: BackgroundRender<MeshGradientRenderer> | null = null;

/**
 * Apple Music's animated mesh gradient of the cover, in place of the Spicy
 * background (which is stopped rather than left rendering underneath). `null`
 * removes it and hands the page back to the Spicy one.
 */
export function setAppleBackground(cover: string | null): void {
  const box = PageContainer?.querySelector<HTMLElement>(".ContentBox");
  if (!cover || !box) {
    background?.dispose();
    background?.getElement().remove();
    background = null;
    KawarpMap.forEach((spicy) => spicy.start());
    return;
  }

  try {
    if (!background) {
      background = BackgroundRender.new(MeshGradientRenderer);
      background.getElement().classList.add("sl-amll-bg");
    }
    box.prepend(background.getElement());
    // Every call, not only the first: the Spicy background restarts itself on
    // each new cover.
    KawarpMap.forEach((spicy) => spicy.stop());
    void background.setAlbum(cover).catch((err) => {
      console.warn("[SpicyLyrics] Apple Music background could not load the cover", err);
    });
  } catch (err) {
    // No WebGL: keep the Spicy background, which has its own CSS fallback.
    console.warn("[SpicyLyrics] Apple Music background unavailable", err);
    setAppleBackground(null);
  }
}
