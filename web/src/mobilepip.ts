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
let timer: ReturnType<typeof setInterval> | null = null;
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

const W = 960;
const H = 540;
const t0 = performance.now();

// Colours sampled from the cover, used for the animated background (close to the
// site's dynamic background). We never draw the cover itself onto the PiP canvas
// — that would taint it and break captureStream — only synthetic gradients built
// from sampled averages.
let palette: [string, string] = ["#2a2320", "#0b0a09"];
let paletteFor: string | null = null;

function samplePalette(coverUrl: string | undefined): void {
  if (!coverUrl || coverUrl === paletteFor) return;
  paletteFor = coverUrl;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = 16;
      c.height = 16;
      const cc = c.getContext("2d");
      if (!cc) return;
      cc.drawImage(img, 0, 0, 16, 16);
      const d = cc.getImageData(0, 0, 16, 16).data; // throws if tainted (no CORS)
      let r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0, n = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const i = (y * 16 + x) * 4;
          if (y < 8) { r1 += d[i]; g1 += d[i + 1]; b1 += d[i + 2]; }
          else { r2 += d[i]; g2 += d[i + 1]; b2 += d[i + 2]; }
        }
      }
      n = 128;
      const mix = (v: number, k: number) => Math.round((v / n) * k);
      palette = [
        `rgb(${mix(r1, 0.6)},${mix(g1, 0.6)},${mix(b1, 0.6)})`,
        `rgb(${mix(r2, 0.28)},${mix(g2, 0.28)},${mix(b2, 0.28)})`,
      ];
    } catch {
      /* tainted cover → keep the current palette */
    }
  };
  img.src = coverUrl;
}

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

function lineProgress(line: Line, pos: number): number {
  if (line.start == null || line.end == null || line.end <= line.start) return 0;
  return Math.min(1, Math.max(0, (pos - line.start) / (line.end - line.start)));
}

// Driven by setInterval (not rAF): rAF is paused while the tab is in the
// background — which is exactly when PiP is useful — and a stalled canvas ends
// the MediaStream, closing the PiP. setInterval keeps frames flowing.
function draw(): void {
  if (!ctx) return;
  const pos = SpotifyPlayer.GetPosition();
  const anim = (performance.now() - t0) / 1000;
  const cx = W / 2;
  const maxW = W * 0.9;

  // Animated dynamic-colour background (approximates the site's warp bg).
  ctx.filter = "none";
  const sx = Math.sin(anim * 0.25) * 60;
  const g = ctx.createLinearGradient(-sx, -sx, W + sx, H + sx);
  g.addColorStop(0, palette[0]);
  g.addColorStop(1, palette[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const rg = ctx.createRadialGradient(
    cx + Math.sin(anim * 0.4) * 120,
    H * 0.4,
    40,
    cx,
    H * 0.5,
    W * 0.75
  );
  rg.addColorStop(0, "rgba(0,0,0,0)");
  rg.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (!model.length) {
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.font = `600 34px "SpicyLyrics", system-ui, sans-serif`;
    ctx.fillText(SpotifyPlayer.GetName() ?? "Spicy Lyrics", cx, H / 2);
    return;
  }

  const i = activeIndex(pos);
  const centerY = H * 0.5;
  const gap = 84;

  // Neighbour lines: dimmer + progressively blurred, like the site.
  for (let off = -2; off <= 2; off++) {
    const idx = i + off;
    if (idx < 0 || idx >= model.length || off === 0) continue;
    const line = model[idx];
    const dist = Math.abs(off);
    const size = fitFont(line.text, maxW, 34, 20);
    ctx.font = `700 ${size}px "SpicyLyrics", system-ui, -apple-system, sans-serif`;
    ctx.filter = `blur(${dist * 1.6}px)`;
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(255,255,255,${Math.max(0.14, 0.4 - dist * 0.1)})`;
    ctx.fillText(ellipsize(line.text, maxW), cx, centerY + off * gap);
  }

  // Active line: bright, glowing, karaoke fill.
  const line = model[i] ?? model[0];
  const size = fitFont(line.text, maxW, 50, 26);
  ctx.font = `800 ${size}px "SpicyLyrics", system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(line.text).width;
  ctx.filter = "none";

  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,.34)";
  ctx.fillText(line.text, cx, centerY);

  const progress = lineProgress(line, pos);
  if (progress > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - textW / 2, centerY - size, textW * progress, size * 2);
    ctx.clip();
    ctx.shadowColor = "rgba(255,255,255,.6)";
    ctx.shadowBlur = 22;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line.text, cx, centerY);
    ctx.restore();
  }
  ctx.filter = "none";
  ctx.shadowBlur = 0;
}

/** Visible on-page preview of the PiP rendering (?pippreview) — for tuning. */
export function startPipPreview(): void {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  ctx = canvas.getContext("2d");
  canvas.style.cssText =
    "position:fixed;right:12px;bottom:12px;width:384px;height:216px;z-index:3000;" +
    "border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.15)";
  document.body.appendChild(canvas);
  samplePalette(SpotifyPlayer.GetCover("large"));
  draw();
  timer = setInterval(draw, 66);
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

    samplePalette(SpotifyPlayer.GetCover("large"));
    draw(); // paint one frame before capture
    timer = setInterval(draw, 66); // ~15fps, survives backgrounding

    const stream = (canvas as any).captureStream?.(30);
    if (!stream) {
      stop();
      return false;
    }

    video = document.createElement("video");
    video.muted = true;
    (video as any).playsInline = true;
    video.srcObject = stream;
    // Rendered (so the browser considers it PiP-eligible) but hidden behind the
    // opaque page — NOT display:none / opacity:0, which make PiP bail.
    video.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none";
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
  if (timer) clearInterval(timer);
  timer = null;
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
