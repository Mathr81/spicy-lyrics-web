// Fullscreen cover controls — faithful to the extension: hovering the artwork
// fades in the playback controls + a seekable timeline, dimming the cover. Uses
// the extension's exact DOM classes, real Icons and real Spring so it looks and
// feels identical, wired to the standalone Spotify adapter.
import { Icons } from "@src/components/Styling/Icons.ts";
import { Spring } from "@src/modules/Spring.ts";
import { SDK_SUPPORTED } from "./config.ts";
import { pipSupported } from "./pip.ts";
import { SpotifyPlayer } from "./shim/SpotifyPlayer.ts";
import {
  togglePlay,
  skipNext,
  skipPrev,
  seekTo,
  toggleShuffle,
  cycleRepeat,
  onUpdate,
  getSnapshot,
} from "./spotify/player.ts";

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// A monitor glyph for the "play in this browser" (SDK opt-in) control.
const DEVICE_ICON = `<svg class="NoFill" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`;

export interface MediaBoxCallbacks {
  onToggleFullscreen: () => void;
  onToggleRomanization: () => void;
  onEnableSdk: () => void;
  onTogglePip: () => void;
}

export interface MediaBoxHandle {
  setRomanizationAvailable: (v: boolean) => void;
  setFullscreenActive: (v: boolean) => void;
  setSdkActive: (v: boolean) => void;
}

export function setupMediaBoxControls(
  page: HTMLElement,
  cb: MediaBoxCallbacks
): MediaBoxHandle {
  const mediaBox = page.querySelector<HTMLElement>(".NowBar .Header .MediaBox")!;
  const mediaContent = page.querySelector<HTMLElement>(
    ".NowBar .Header .MediaBox .MediaContent"
  )!;

  const fullscreenSupported =
    typeof document.fullscreenEnabled === "boolean"
      ? document.fullscreenEnabled
      : "requestFullscreen" in document.documentElement;
  const sdkSupported = SDK_SUPPORTED;

  mediaContent.innerHTML = `
    <div class="ViewControls">
      ${sdkSupported ? `<button class="ViewControl ListenHere" title="Écouter dans cet onglet">${DEVICE_ICON}</button>` : ""}
      <button class="ViewControl RomanizationToggle" title="Romanisation" hidden>${Icons.EnableRomanization}</button>
      ${pipSupported() ? `<button class="ViewControl PipToggle" title="Picture-in-Picture">${Icons.PiPMode}</button>` : ""}
      ${fullscreenSupported ? `<button class="ViewControl FullscreenToggle" title="Plein écran">${Icons.Fullscreen}</button>` : ""}
    </div>
    <div class="PlaybackControls">
      <div class="PlaybackControl ShuffleToggle">${Icons.Shuffle}</div>
      ${Icons.PrevTrack}
      <div class="PlaybackControl PlayStateToggle Paused">${Icons.Play}</div>
      ${Icons.NextTrack}
      <div class="PlaybackControl LoopToggle">${Icons.Loop}</div>
    </div>
    <div class="Timeline">
      <span class="Time Position">0:00</span>
      <div class="SliderBar" style="--SliderProgress: 0"><div class="Handle"></div></div>
      <span class="Time Duration">0:00</span>
    </div>
  `;

  const fullBtn = mediaContent.querySelector<HTMLElement>(".FullscreenToggle");
  const romBtn = mediaContent.querySelector<HTMLElement>(".RomanizationToggle");
  const listenBtn = mediaContent.querySelector<HTMLElement>(".ListenHere");
  const pipBtn = mediaContent.querySelector<HTMLElement>(".PipToggle");
  fullBtn?.addEventListener("click", cb.onToggleFullscreen);
  romBtn?.addEventListener("click", cb.onToggleRomanization);
  listenBtn?.addEventListener("click", cb.onEnableSdk);
  pipBtn?.addEventListener("click", cb.onTogglePip);

  const playToggle = mediaContent.querySelector<HTMLElement>(".PlayStateToggle")!;
  const prev = mediaContent.querySelector<HTMLElement>(".PrevTrack")!;
  const next = mediaContent.querySelector<HTMLElement>(".NextTrack")!;
  const shuffle = mediaContent.querySelector<HTMLElement>(".ShuffleToggle")!;
  const loop = mediaContent.querySelector<HTMLElement>(".LoopToggle")!;
  const slider = mediaContent.querySelector<HTMLElement>(".SliderBar")!;
  const posEl = mediaContent.querySelector<HTMLElement>(".Time.Position")!;
  const durEl = mediaContent.querySelector<HTMLElement>(".Time.Duration")!;

  // Press feedback (matches the extension's .Pressed class).
  for (const ctrl of mediaContent.querySelectorAll<HTMLElement>(".PlaybackControl")) {
    const press = () => ctrl.classList.add("Pressed");
    const release = () => ctrl.classList.remove("Pressed");
    ctrl.addEventListener("pointerdown", press);
    ctrl.addEventListener("pointerup", release);
    ctrl.addEventListener("pointerleave", release);
  }

  playToggle.addEventListener("click", () => void togglePlay());
  prev.addEventListener("click", () => void skipPrev());
  next.addEventListener("click", () => void skipNext());
  shuffle.addEventListener("click", () => void toggleShuffle());
  loop.addEventListener("click", () => void cycleRepeat());

  // --- Seek ---
  let seeking = false;
  const fractionFromEvent = (e: PointerEvent): number => {
    const rect = slider.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  const previewSeek = (f: number) => {
    slider.style.setProperty("--SliderProgress", `${f}`);
    posEl.textContent = fmt(f * SpotifyPlayer.GetDuration());
  };
  slider.addEventListener("pointerdown", (e) => {
    seeking = true;
    slider.setPointerCapture(e.pointerId);
    previewSeek(fractionFromEvent(e));
  });
  slider.addEventListener("pointermove", (e) => {
    if (seeking) previewSeek(fractionFromEvent(e));
  });
  const endSeek = (e: PointerEvent) => {
    if (!seeking) return;
    seeking = false;
    const f = fractionFromEvent(e);
    void seekTo(f * SpotifyPlayer.GetDuration());
  };
  slider.addEventListener("pointerup", endSeek);
  slider.addEventListener("pointercancel", () => {
    seeking = false;
  });

  // --- Timeline tick ---
  setInterval(() => {
    if (seeking) return;
    const dur = SpotifyPlayer.GetDuration();
    const pos = SpotifyPlayer.GetPosition();
    posEl.textContent = fmt(pos);
    durEl.textContent = fmt(dur);
    slider.style.setProperty("--SliderProgress", `${dur > 0 ? pos / dur : 0}`);
  }, 250);

  // --- Playback state → icons ---
  const applyState = () => {
    const s = getSnapshot();
    playToggle.classList.toggle("Playing", s.isPlaying);
    playToggle.classList.toggle("Paused", !s.isPlaying);
    playToggle.innerHTML = s.isPlaying ? Icons.Pause : Icons.Play;
    shuffle.classList.toggle("Enabled", s.shuffle);
    loop.classList.toggle("Enabled", s.repeat !== "off");
    loop.innerHTML = s.repeat === "track" ? Icons.LoopTrack : Icons.Loop;
  };
  onUpdate(applyState);
  applyState();

  // --- Hover reveal (springs, like Fullscreen.ts) ---
  const opacity = new Spring(0, 2, 2, 0);
  const brightness = new Spring(1, 2, 2, 1);
  let mediaHover = false;
  let lastMove = 0;
  let raf = 0;
  let lastTs = performance.now();

  const goals = () => {
    const recentlyMoved = performance.now() - lastMove < 900;
    if (mediaHover) return { o: 0.985, b: 0.55 };
    if (recentlyMoved) return { o: 0.65, b: 0.78 };
    return { o: 0, b: 1 };
  };

  const animate = () => {
    const now = performance.now();
    const dt = (now - lastTs) / 1000;
    lastTs = now;
    const g = goals();
    opacity.SetGoal(g.o);
    brightness.SetGoal(g.b);
    const o = opacity.Step(dt);
    const b = brightness.Step(dt);
    mediaBox.style.setProperty("--ControlsOpacity", `${o}`);
    mediaBox.style.setProperty("--ArtworkBrightness", `${b}`);
    if (opacity.CanSleep() && brightness.CanSleep() && goals().o === 0) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(animate);
  };
  const kick = () => {
    if (!raf) {
      lastTs = performance.now();
      raf = requestAnimationFrame(animate);
    }
  };

  mediaBox.addEventListener("mouseenter", () => {
    mediaHover = true;
    kick();
  });
  mediaBox.addEventListener("mouseleave", () => {
    mediaHover = false;
    kick();
  });
  page.addEventListener("mousemove", () => {
    lastMove = performance.now();
    kick();
  });

  // Touch devices (iPad/iOS) have no hover — tapping the cover reveals the
  // controls for a few seconds.
  let touchTimer: number | undefined;
  mediaBox.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    mediaHover = true;
    kick();
    window.clearTimeout(touchTimer);
    touchTimer = window.setTimeout(() => {
      mediaHover = false;
      kick();
    }, 4000);
  });

  return {
    setRomanizationAvailable(v) {
      if (romBtn) romBtn.hidden = !v;
    },
    setFullscreenActive(v) {
      if (fullBtn) fullBtn.innerHTML = v ? Icons.CloseFullscreen : Icons.Fullscreen;
    },
    setSdkActive(v) {
      if (listenBtn) listenBtn.hidden = v;
    },
  };
}
