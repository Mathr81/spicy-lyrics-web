// Apple Music-style lyrics view — the alternative to the Spicy renderer, chosen
// in Settings. The rendering itself is AMLL's (@applemusic-like-lyrics/core):
// this module only converts the Spicy Lyrics payload to AMLL's line model and
// feeds it the same playback clock the Spicy animator reads.
//
// Loaded on demand (see apply.ts), so the default Spicy view doesn't pay for it.
import { LyricPlayer, type LyricLineMouseEvent } from "@applemusic-like-lyrics/core";
import { PageContainer } from "../shim/PageView.ts";
import { SpotifyPlayer, isPlaying } from "../shim/SpotifyPlayer.ts";
import { seekToLyricTime } from "../lineseek.ts";
import { toLines } from "./amll-lines.ts";

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
    player.getElement().classList.add("sl-amll");
    player.addEventListener("line-click", (e) => {
      seekToLyricTime((e as LyricLineMouseEvent).line.getLine().startTime);
    });
  }

  // Attached before the lines are set, so AMLL measures them at their real size.
  host.appendChild(player.getElement());
  page.classList.add(PAGE_CLASS);

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
  player?.getElement().remove();
  PageContainer?.classList.remove(PAGE_CLASS);
}
