// Browser shim for `src/components/DynamicBG/dynamicBackground.ts`.
//
// Reuses the real Kawarp WebGL warp effect (the same @kawarp/core library the
// extension uses) driven by the current cover art, including the extension's
// playback-driven animation speed. The extension's other modes (artist-header
// static bg, GraphQL dynamic colors) are dropped — the standalone always uses
// the animated cover warp.
import Kawarp, { type KawarpOptions } from "@kawarp/core";
import { SpotifyPlayer, isPlaying } from "./SpotifyPlayer.ts";
import {
  BackgroundAnimationController,
  type AudioAnalysisData,
} from "@src/components/DynamicBG/BackgroundAnimationController.ts";
import { getAudioAnalysis } from "../spotify/api.ts";

export const KawarpMap = new Map<HTMLElement | string, Kawarp>();

// ---------------------------------------------------------------------------
// Animation speed
//
// `animationSpeed: 0.1` in the options below is the extension's PAUSED speed,
// not a resting one. dynamicBackground.ts never leaves it there: it drives the
// live value from `playback:playpause` (1 while playing, 0.1 while paused) and,
// on every progress tick, from the beat/tempo/loudness multiplier
// BackgroundAnimationController derives from Spotify's audio analysis.
//
// This shim used to construct Kawarp and never touch the option again, so the
// warp ran at a tenth of the extension's resting speed for the entire session —
// slow enough to read as a background that simply does not animate.
// ---------------------------------------------------------------------------

const PAUSED_ANIMATION_SPEED = 0.1;
/** What the extension falls back to for any track it has no analysis for. */
const DEFAULT_ANIMATION_SPEED = 1;
// The extension re-evaluates on Spotify's `onprogress`, which is coarser than a
// frame; matching that rate keeps the beat pulse alive without a per-frame WebGL
// uniform write. Kawarp eases towards the value it is given, so this is smooth.
const SPEED_TICK_MS = 100;

const animSpeedController = new BackgroundAnimationController();

function setAnimationSpeed(speed: number): void {
  KawarpMap.forEach((instance) => {
    instance.setOptions({ animationSpeed: speed });
  });
}

// Spotify withdrew /v1/audio-analysis for apps registered after 2024-11-27, so
// for most deployments the very first request answers 403. Record that once and
// stop asking: the background then behaves exactly as the extension does on a
// track with no analysis, rather than firing a doomed request per song.
let analysisEndpointAvailable = true;
// One entry per track, written once — including on failure, so a tick running
// every SPEED_TICK_MS can never turn into a request loop. The cost of that is a
// track losing its beat pulse for the session if its one request happened to hit
// a network blip; the alternative is retrying ten times a second.
const analysisCache = new Map<string, AudioAnalysisData | null>();
const analysisInflight = new Set<string>();

/**
 * The analysis for `uri` if we already have it. Returns null while a request is
 * in flight (and starts one if this track has never been asked for), so the
 * caller keeps animating at the default speed until the data lands.
 */
function analysisFor(uri: string): AudioAnalysisData | null {
  const trackId = uri.split(":")[2];
  if (!trackId) return null;

  const cached = analysisCache.get(trackId);
  if (cached !== undefined) return cached;
  if (!analysisEndpointAvailable || analysisInflight.has(trackId)) return null;

  analysisInflight.add(trackId);
  void getAudioAnalysis(trackId)
    .then((result) => {
      if (result.status === "unavailable") {
        // Withdrawn per app, not per track — nothing else will succeed either.
        analysisEndpointAvailable = false;
        analysisCache.set(trackId, null);
        return;
      }
      analysisCache.set(
        trackId,
        result.status === "ok" ? (result.data as AudioAnalysisData) : null
      );
    })
    .catch(() => {
      // Transient (network, 429, expired token). Leave the endpoint enabled for
      // other tracks, but don't ask about this one again.
      analysisCache.set(trackId, null);
    })
    .finally(() => {
      analysisInflight.delete(trackId);
    });

  return null;
}

function tickAnimationSpeed(): void {
  if (KawarpMap.size === 0) return;

  // Mirrors the extension's `playback:playpause` handler; polled rather than
  // event-driven because the same tick has to re-evaluate the beat pulse anyway.
  if (!isPlaying()) {
    setAnimationSpeed(PAUSED_ANIMATION_SPEED);
    return;
  }

  const uri = SpotifyPlayer.GetUri();
  if (!uri || uri.startsWith("spotify:local:")) {
    setAnimationSpeed(DEFAULT_ANIMATION_SPEED);
    return;
  }

  const analysis = analysisFor(uri);
  if (!analysis) {
    setAnimationSpeed(DEFAULT_ANIMATION_SPEED);
    return;
  }

  setAnimationSpeed(
    animSpeedController.getSpeedMultiplier(SpotifyPlayer.GetPosition() / 1000, analysis)
  );
}

let speedTicker: ReturnType<typeof setInterval> | null = null;

/** Start driving the warp speed from playback. Idempotent. */
function startAnimationSpeedDriver(): void {
  if (speedTicker !== null) return;
  speedTicker = setInterval(tickAnimationSpeed, SPEED_TICK_MS);
}

const KawarpOptionsStatic: KawarpOptions = {
  warpIntensity: 1,
  blurPasses: 8,
  // The PAUSED speed, not a resting one — see the animation-speed section below.
  animationSpeed: PAUSED_ANIMATION_SPEED,
  saturation: 1.5,
  dithering: 0.008,
  transitionDuration: 500,
  tintIntensity: 0,
  scale: 1,
};

function cssFallback(element: HTMLElement, cover: string): void {
  let bg = element.querySelector<HTMLElement>(".spicy-dynamic-bg.CssFallback");
  if (!bg) {
    bg = document.createElement("div");
    bg.classList.add("spicy-dynamic-bg", "CssFallback");
    element.prepend(bg);
  }
  bg.style.backgroundImage = `url("${cover}")`;
  bg.setAttribute("data-cover-id", cover);
}

export default async function ApplyDynamicBackground(
  element: HTMLElement,
  tag?: string
): Promise<void> {
  if (!element) return;
  const cover = SpotifyPlayer.GetCover("large") ?? "";
  if (!cover) return;

  const existing = element.querySelector<HTMLElement>(".spicy-dynamic-bg");
  if (existing && existing.getAttribute("data-cover-id") === cover) return;

  const key = tag ?? element;
  const instance = KawarpMap.get(key);

  try {
    if (instance) {
      const canvas = element.querySelector<HTMLElement>("canvas.spicy-dynamic-bg");
      canvas?.setAttribute("data-cover-id", cover);
      await instance.loadImage(cover);
      instance.start();
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.classList.add("spicy-dynamic-bg");
    canvas.setAttribute("data-cover-id", cover);
    const kawarp = new Kawarp(canvas, KawarpOptionsStatic);
    KawarpMap.set(key, kawarp);
    element.prepend(canvas);
    await kawarp.loadImage(cover);
    kawarp.start();
    // The instance is born at the paused speed; hand it straight to the driver
    // so a background created mid-playback doesn't crawl until the first tick.
    startAnimationSpeedDriver();
    tickAnimationSpeed();
    setTimeout(() => void kawarp.setOptions({ transitionDuration: 1000 }), 1000);
  } catch (err) {
    console.warn("[SpicyLyrics] Kawarp background failed; using CSS fallback", err);
    KawarpMap.delete(key);
    cssFallback(element, cover);
  }
}

export async function GetStaticBackground(): Promise<string | undefined> {
  return undefined;
}
