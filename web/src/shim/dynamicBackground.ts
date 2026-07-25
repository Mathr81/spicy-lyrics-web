// Browser shim for `src/components/DynamicBG/dynamicBackground.ts`.
//
// Reuses the real Kawarp WebGL warp effect (the same @kawarp/core library the
// extension uses) driven by the current cover art. The extension's extra modes
// (artist-header static bg, GraphQL dynamic colors, audio-analysis speed) are
// dropped — the standalone always uses the animated cover warp.
import Kawarp, { type KawarpOptions } from "@kawarp/core";
import { SpotifyPlayer } from "./SpotifyPlayer.ts";

export const KawarpMap = new Map<HTMLElement | string, Kawarp>();

const KawarpOptionsStatic: KawarpOptions = {
  warpIntensity: 1,
  blurPasses: 8,
  animationSpeed: 0.1,
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
