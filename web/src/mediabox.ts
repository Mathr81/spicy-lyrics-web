// Fullscreen cover controls — faithful to the extension: hovering the artwork
// fades in the playback controls + a seekable timeline, dimming the cover. Uses
// the extension's exact DOM classes, real Icons and real Spring so it looks and
// feels identical, wired to the standalone Spotify adapter.
import { Icons } from "@src/components/Styling/Icons.ts";
import { Spring } from "@src/modules/Spring.ts";
import { SDK_SUPPORTED } from "./config.ts";
import { pipSupported } from "./pip.ts";
import { videoPipSupported } from "./mobilepip.ts";
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
  onSwapSides: () => void;
  onToggleCompact: () => boolean;
  onOpenSettings: () => void;
}

export interface MediaBoxHandle {
  setRomanizationAvailable: (v: boolean) => void;
  setFullscreenActive: (v: boolean) => void;
  setSdkActive: (v: boolean) => void;
  setCompactActive: (v: boolean) => void;
}

export function setupMediaBoxControls(
  page: HTMLElement,
  cb: MediaBoxCallbacks
): MediaBoxHandle {
  const mediaBox = page.querySelector<HTMLElement>(".NowBar .Header .MediaBox")!;
  const mediaContent = page.querySelector<HTMLElement>(
    ".NowBar .Header .MediaBox .MediaContent"
  )!;

  // Include the webkit-prefixed API so the control shows on iPad Safari (which
  // only implements fullscreen under that prefix). In "Add to Home Screen"
  // standalone mode iOS exposes no fullscreen API, so the button correctly stays
  // hidden there.
  const de = document as Document & { webkitFullscreenEnabled?: boolean };
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: unknown;
  };
  const fullscreenSupported = !!(
    de.fullscreenEnabled ||
    de.webkitFullscreenEnabled ||
    "requestFullscreen" in el ||
    "webkitRequestFullscreen" in el
  );
  const sdkSupported = SDK_SUPPORTED;

  mediaContent.innerHTML = `
    <div class="ViewControls">
      <button class="ViewControl CompactModeToggle" title="Mode compact">${Icons.EnableCompactModeIcon}</button>
      <button class="ViewControl NowBarSideToggle" title="Inverser la cover et les paroles">${Icons.NowBarSideSwap}</button>
      <button class="ViewControl RomanizationToggle" title="Romanisation" hidden>${Icons.EnableRomanization}</button>
      ${sdkSupported ? `<button class="ViewControl ListenHere" title="Écouter dans cet onglet">${DEVICE_ICON}</button>` : ""}
      ${pipSupported() || videoPipSupported() ? `<button class="ViewControl PipToggle" title="Picture-in-Picture">${Icons.PiPMode}</button>` : ""}
      ${fullscreenSupported ? `<button class="ViewControl FullscreenToggle" title="Plein écran">${Icons.Fullscreen}</button>` : ""}
      <button class="ViewControl SettingsToggle" title="Réglages">${Icons.Settings}</button>
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
  const swapBtn = mediaContent.querySelector<HTMLElement>(".NowBarSideToggle");
  const compactBtn = mediaContent.querySelector<HTMLElement>(".CompactModeToggle");
  const settingsBtn = mediaContent.querySelector<HTMLElement>(".SettingsToggle");
  fullBtn?.addEventListener("click", cb.onToggleFullscreen);
  romBtn?.addEventListener("click", cb.onToggleRomanization);
  listenBtn?.addEventListener("click", cb.onEnableSdk);
  pipBtn?.addEventListener("click", cb.onTogglePip);
  swapBtn?.addEventListener("click", cb.onSwapSides);
  settingsBtn?.addEventListener("click", cb.onOpenSettings);
  const setCompactIcon = (active: boolean) => {
    if (compactBtn)
      compactBtn.innerHTML = active
        ? Icons.DisableCompactModeIcon
        : Icons.EnableCompactModeIcon;
  };
  compactBtn?.addEventListener("click", () => setCompactIcon(cb.onToggleCompact()));

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
  // A finger gets the whole timeline row, time labels included: the bar itself is
  // a few pixels tall, which is fine for a cursor and a miss for a thumb. A mouse
  // keeps to the bar, so clicking a time label does not jump to either end.
  const timeline = mediaContent.querySelector<HTMLElement>(".Timeline")!;
  let seeking = false;
  const fractionFromEvent = (e: PointerEvent): number => {
    const rect = slider.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  const previewSeek = (f: number) => {
    slider.style.setProperty("--SliderProgress", `${f}`);
    posEl.textContent = fmt(f * SpotifyPlayer.GetDuration());
  };
  timeline.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !slider.contains(e.target as Node)) return;
    seeking = true;
    slider.classList.add("Dragging");
    timeline.setPointerCapture(e.pointerId);
    previewSeek(fractionFromEvent(e));
  });
  timeline.addEventListener("pointermove", (e) => {
    if (seeking) previewSeek(fractionFromEvent(e));
  });
  const stopSeeking = () => {
    seeking = false;
    slider.classList.remove("Dragging");
  };
  timeline.addEventListener("pointerup", (e) => {
    if (!seeking) return;
    stopSeeking();
    void seekTo(fractionFromEvent(e) * SpotifyPlayer.GetDuration());
  });
  timeline.addEventListener("pointercancel", stopSeeking);

  // --- Timeline tick ---
  setInterval(() => {
    if (seeking) return;
    const dur = SpotifyPlayer.GetDuration();
    const pos = SpotifyPlayer.GetPosition();
    posEl.textContent = fmt(pos);
    durEl.textContent = fmt(dur);
    slider.style.setProperty("--SliderProgress", `${dur > 0 ? pos / dur : 0}`);
  }, 250);

  // Phone layout only (CSS shows it there): play/pause without opening the cover.
  const miniPlay = page.querySelector<HTMLButtonElement>(".NowBar .Header .sl-mini-play");
  miniPlay?.addEventListener("click", () => void togglePlay());

  // --- Playback state → icons ---
  const applyState = () => {
    const s = getSnapshot();
    if (miniPlay) {
      miniPlay.innerHTML = s.isPlaying ? Icons.Pause : Icons.Play;
      miniPlay.setAttribute("aria-label", s.isPlaying ? "Pause" : "Lecture");
    }
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

  // Mouse only: a tap also fires compatibility mouse events, and on a touch screen
  // a synthesized mouseenter never gets its mouseleave, which left the controls
  // stuck on after the first tap.
  mediaBox.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    mediaHover = true;
    kick();
  });
  mediaBox.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    mediaHover = false;
    kick();
  });
  page.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    lastMove = performance.now();
    kick();
  });

  // --- Touch: tap to reveal ---
  // Touch screens have no hover, so a tap on the cover (or, on a phone, on the
  // title beside it) reveals the controls for a few seconds. `sl-controls-live`
  // on the page mirrors that state: the phone layout keys its expanded card
  // off it.
  //
  // The controls are invisible but still laid out while hidden, so the tap that
  // reveals them must not also press whichever one is under the finger: that
  // tap is swallowed, pointerdown (the seek bar) and click (everything else)
  // alike. Once revealed, taps go through and push the auto-hide back.
  const header = page.querySelector<HTMLElement>(".NowBar .Header")!;
  const REVEAL_MS = 5000;
  let revealed = false;
  let hideTimer: number | undefined;
  let swallowClick = false;

  const setRevealed = (v: boolean) => {
    revealed = v;
    mediaHover = v;
    page.classList.toggle("sl-controls-live", v);
    window.clearTimeout(hideTimer);
    if (v) hideTimer = window.setTimeout(() => setRevealed(false), REVEAL_MS);
    kick();
  };
  const holdOpen = () => {
    if (!revealed) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => setRevealed(false), REVEAL_MS);
  };

  header.addEventListener(
    "pointerdown",
    (e) => {
      swallowClick = false;
      if (e.pointerType === "mouse") return;
      const target = e.target as Element;
      if (target.closest(".sl-mini-play")) return;
      if (!revealed && (mediaBox.contains(target) || target.closest(".Metadata"))) {
        e.stopPropagation();
        swallowClick = true;
        setRevealed(true);
        return;
      }
      holdOpen();
    },
    true
  );
  // A seek drag can outlast the timer; count its release as activity too.
  header.addEventListener("pointerup", holdOpen, true);
  header.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

  // A tap anywhere else puts the controls away. In the phone layout the open
  // card covers the lyrics, so that tap is only a dismissal and goes no further.
  let swallowPageClick = false;
  page.addEventListener(
    "pointerdown",
    (e) => {
      swallowPageClick = false;
      if (!revealed || e.pointerType === "mouse") return;
      if (header.contains(e.target as Node)) return;
      setRevealed(false);
      if (page.classList.contains("CompactMode")) {
        e.stopPropagation();
        swallowPageClick = true;
      }
    },
    true
  );
  page.addEventListener(
    "click",
    (e) => {
      if (!swallowPageClick) return;
      swallowPageClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

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
    setCompactActive(v) {
      setCompactIcon(v);
    },
  };
}
