// Video Picture-in-Picture — the only way a web page can float an overlay over
// another app (e.g. Spotify) on mobile. We render a compact karaoke view onto a
// <canvas>, stream it into a hidden <video>, and hand that to the browser's
// video PiP. Works on Android Chrome + desktop. iOS Safari generally refuses PiP
// for canvas MediaStreams (Apple limitation) — we still try the webkit path.
import { SpotifyPlayer } from "./shim/SpotifyPlayer.ts";

interface Line {
  text: string;
  start: number | null; // ms
  end: number | null;
}

let lyrics: any = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let video: HTMLVideoElement | null = null;
let raf = 0;
let active = false;
let model: Line[] = [];

export function setPipLyrics(data: any): void {
  lyrics = data;
  model = buildModel(data);
}

export function videoPipSupported(): boolean {
  if ((document as any).pictureInPictureEnabled) return true;
  const v = document.createElement("video");
  return typeof (v as any).webkitSetPresentationMode === "function";
}

export function isVideoPipOpen(): boolean {
  return active;
}

function buildModel(data: any): Line[] {
  if (!data) return [];
  if (data.Type === "Syllable" && Array.isArray(data.Content)) {
    return data.Content
      .filter((l: any) => l?.Lead?.Syllables)
      .map((l: any) => ({
        text: l.Lead.Syllables.map(
          (s: any, i: number) => (i > 0 && !s.IsPartOfWord ? " " : "") + s.Text
        ).join(""),
        start: l.Lead.StartTime * 1000,
        end: l.Lead.EndTime * 1000,
      }));
  }
  if (data.Type === "Line" && Array.isArray(data.Content)) {
    return data.Content
      .filter((l: any) => l?.Text)
      .map((l: any) => ({ text: l.Text, start: l.StartTime * 1000, end: l.EndTime * 1000 }));
  }
  if (data.Type === "Static" && Array.isArray(data.Lines)) {
    return data.Lines.map((l: any) => ({ text: l.Text, start: null, end: null }));
  }
  return [];
}

const W = 720;
const H = 405;

function fitFont(text: string, maxWidth: number, base: number, min: number): number {
  if (!ctx) return base;
  let size = base;
  for (; size > min; size -= 2) {
    ctx.font = `700 ${size}px "SpicyLyrics", system-ui, -apple-system, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return size;
}

function ellipsize(text: string, maxWidth: number): string {
  if (!ctx) return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function activeIndex(pos: number): number {
  if (!model.length) return -1;
  for (let i = 0; i < model.length; i++) {
    const l = model[i];
    if (l.start == null || l.end == null) continue;
    if (pos >= l.start && pos < l.end) return i;
  }
  // between lines → the last line already started
  let idx = -1;
  for (let i = 0; i < model.length; i++) {
    if (model[i].start != null && pos >= (model[i].start as number)) idx = i;
  }
  return idx;
}

function draw(): void {
  raf = requestAnimationFrame(draw);
  if (!ctx) return;
  const pos = SpotifyPlayer.GetPosition();

  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#14141a");
  grad.addColorStop(1, "#000000");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (!model.length) {
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.font = `600 30px "SpicyLyrics", system-ui, sans-serif`;
    ctx.fillText(SpotifyPlayer.GetName() ?? "Spicy Lyrics", W / 2, H / 2);
    return;
  }

  const i = activeIndex(pos);
  const maxW = W * 0.9;
  const cx = W / 2;

  // Neighbour lines (dim).
  ctx.fillStyle = "rgba(255,255,255,.28)";
  ctx.font = `700 26px "SpicyLyrics", system-ui, sans-serif`;
  if (i - 1 >= 0) ctx.fillText(ellipsize(model[i - 1].text, maxW), cx, H / 2 - 96);
  if (i + 1 < model.length) ctx.fillText(ellipsize(model[i + 1].text, maxW), cx, H / 2 + 96);

  // Active line with karaoke fill.
  const line = model[i] ?? model[0];
  const size = fitFont(line.text, maxW, 46, 24);
  ctx.font = `700 ${size}px "SpicyLyrics", system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(line.text).width;
  const y = H / 2;

  // dim base
  ctx.fillStyle = "rgba(255,255,255,.32)";
  ctx.fillText(line.text, cx, y);

  // filled portion
  let progress = 0;
  if (line.start != null && line.end != null && line.end > line.start) {
    progress = Math.min(1, Math.max(0, (pos - line.start) / (line.end - line.start)));
  }
  if (progress > 0) {
    ctx.save();
    const left = cx - textW / 2;
    ctx.beginPath();
    ctx.rect(left, y - size, textW * progress, size * 2);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line.text, cx, y);
    ctx.restore();
  }
}

export async function toggleVideoPip(): Promise<boolean> {
  if (active) {
    stop();
    return false;
  }
  try {
    canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext("2d");
    if (!ctx) return false;

    draw(); // start producing frames before capture

    const stream = (canvas as any).captureStream?.(30);
    if (!stream) {
      stop();
      return false;
    }

    video = document.createElement("video");
    video.muted = true;
    (video as any).playsInline = true;
    video.srcObject = stream;
    video.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);

    await video.play();

    if ((video as any).requestPictureInPicture && (document as any).pictureInPictureEnabled) {
      await (video as any).requestPictureInPicture();
      video.addEventListener("leavepictureinpicture", stop, { once: true });
    } else if (typeof (video as any).webkitSetPresentationMode === "function") {
      (video as any).webkitSetPresentationMode("picture-in-picture");
      video.addEventListener("webkitpresentationmodechanged", () => {
        if ((video as any)?.webkitPresentationMode !== "picture-in-picture") stop();
      });
    } else {
      stop();
      return false;
    }

    active = true;
    return true;
  } catch (err) {
    console.warn("[SpicyLyrics] video PiP failed", err);
    stop();
    return false;
  }
}

function stop(): void {
  active = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (video) {
    try {
      if ((document as any).pictureInPictureElement === video) {
        void (document as any).exitPictureInPicture?.();
      }
      video.srcObject = null;
    } catch {
      /* ignore */
    }
    video.remove();
    video = null;
  }
  canvas = null;
  ctx = null;
}
