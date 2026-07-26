// Install the window.Spicetify shim BEFORE any engine module is evaluated.
import "./shim/spicetify-global.ts";

// Engine + app styles.
import "@src/css/tokens.css";
import "@src/css/primitives.css";
import "@src/css/default.css";
import "@src/css/default.scss";
import "@src/css/Simplebar.css";
import "@src/css/ContentBox.css";
import "@src/css/DynamicBG/spicy-dynamic-bg.css";
import "@src/css/Lyrics/main.css";
import "@src/css/Lyrics/Mixed.css";
import "@src/css/Loaders/LoaderContainer.css";
import "@src/css/Loaders/DotLoader.css";
import "@src/css/font-pack/font-pack.css";
import "./styles.css";

import { CLIENT_ID } from "./config.ts";
import { handleRedirectCallback, isLoggedIn, login } from "./spotify/auth.ts";
import {
  initPlayer,
  onUpdate,
  enableSdkPlayback,
  getSnapshot,
  type AdapterSnapshot,
} from "./spotify/player.ts";
import { SpotifyPlayer } from "./shim/SpotifyPlayer.ts";
import { type SimpleTrack } from "./spotify/api.ts";
import { fetchLyrics } from "./lyrics/fetch.ts";
import { applyLyrics, clearLyrics } from "./lyrics/apply.ts";
import { buildPage, updateNowBar, showLoader, showNotice } from "./renderer.ts";
import { setupMediaBoxControls, type MediaBoxHandle } from "./mediabox.ts";
import { renderShell, type ShellHandle } from "./ui.ts";
import { $romanization } from "@src/utils/uiState.ts";
import LoadFonts, { ApplyFontPixel } from "@src/components/Styling/Fonts.ts";
import Fullscreen from "./shim/Fullscreen.ts";

const NOTICES: Record<string, string> = {
  "not-found": "Aucune parole disponible pour ce titre.",
  queued: "Votre requête est dans la file d'attente — les paroles arrivent…",
  error: "Une erreur est survenue lors du chargement des paroles.",
  "no-auth": "Connexion Spotify requise.",
};

let currentTrackUri: string | null = null;
let lastLyricsData: any = null;
let hadTrack = true;
let shell: ShellHandle;
let media: MediaBoxHandle;
const lastLyricsInfo = { type: "—", source: "—", lines: 0, translit: false };

async function main(): Promise<void> {
  const root = document.getElementById("SpicyLyricsRoot") as HTMLElement;
  const page = buildPage(root);

  // Load the Spicy Lyrics webfont (same source as the extension).
  LoadFonts();
  ApplyFontPixel();

  shell = renderShell(root, { onLogin: () => void login() });

  // All controls live on the cover, like the extension.
  media = setupMediaBoxControls(page, {
    onToggleFullscreen: () => Fullscreen.Toggle(),
    onToggleRomanization: () => {
      const next = !$romanization.get();
      $romanization.set(next);
      if (lastLyricsData) applyLyrics(lastLyricsData, next);
    },
    onEnableSdk: async () => {
      shell.setStatus("Activation de la lecture dans cet onglet…");
      const ok = await enableSdkPlayback();
      media.setSdkActive(ok);
      shell.setStatus(
        ok
          ? "Lecture dans cet onglet activée."
          : "Impossible d'activer la lecture ici (bloqueur Spotify ?)."
      );
    },
  });

  document.addEventListener("fullscreenchange", () =>
    media.setFullscreenActive(!!document.fullscreenElement)
  );

  // Offline preview: ?demo drives the engine with a built-in sample.
  if (new URLSearchParams(window.location.search).has("demo")) {
    const { startDemo } = await import("./demo.ts");
    startDemo();
    return;
  }

  try {
    await handleRedirectCallback();
  } catch (err) {
    console.error(err);
    shell.setStatus(String((err as Error).message ?? err));
  }

  if (CLIENT_ID === "PUT_YOUR_SPOTIFY_CLIENT_ID_HERE") {
    shell.setStatus("⚠ Configurez votre Client ID Spotify (config.ts).");
  }

  if (!isLoggedIn()) {
    shell.setLoggedIn(false);
    return;
  }

  shell.setLoggedIn(true);

  // Mirror the active Spotify device by default. Playback in this tab (SDK) is
  // opt-in via the cover's "listen here" control — never grabbed on load.
  await initPlayer(false);
  onUpdate(handleSnapshot);
}

function handleSnapshot(snap: AdapterSnapshot): void {
  updateNowBar(snap.track);

  const hasTrack = !!snap.track;
  if (hasTrack !== hadTrack) {
    hadTrack = hasTrack;
    if (!hasTrack) {
      currentTrackUri = null;
      showNotice("Lance un morceau sur Spotify pour voir les paroles.");
    }
  }

  if (snap.track && snap.track.uri !== currentTrackUri) {
    currentTrackUri = snap.track.uri;
    void loadLyrics(snap.track);
  }
}

async function loadLyrics(track: SimpleTrack): Promise<void> {
  clearLyrics();
  showLoader(true);
  const romanize = $romanization.get();
  const res = await fetchLyrics(track.id);
  showLoader(false);

  if (!res.ok) {
    lastLyricsData = null;
    media.setRomanizationAvailable(false);
    showNotice(NOTICES[res.reason] ?? NOTICES.error);
    return;
  }

  lastLyricsData = res.data;
  lastLyricsInfo.type = res.data.Type ?? "—";
  lastLyricsInfo.source = res.data.source ?? "—";
  lastLyricsInfo.lines = Array.isArray(res.data.Content)
    ? res.data.Content.length
    : Array.isArray(res.data.Lines)
      ? res.data.Lines.length
      : 0;
  lastLyricsInfo.translit = res.data.HasTransliterations === true;
  media.setRomanizationAvailable(res.data.HasTransliterations === true);
  applyLyrics(res.data, romanize);
}

// ?debug — a small live overlay to tell apart "API returned unsynced text"
// (Type=Static) from "synced lyrics but the playback clock isn't advancing".
function startDebug(): void {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;bottom:8px;left:8px;z-index:2000;font:12px/1.5 monospace;" +
    "background:rgba(0,0,0,.72);color:#0f0;padding:8px 10px;border-radius:8px;" +
    "pointer-events:none;white-space:pre;max-width:90vw";
  document.body.appendChild(box);
  setInterval(() => {
    const s = getSnapshot();
    const pos = SpotifyPlayer.GetPosition();
    const dur = SpotifyPlayer.GetDuration();
    box.textContent = [
      `mode:     ${s.mode}${s.deviceName ? " (" + s.deviceName + ")" : ""}`,
      `playing:  ${s.isPlaying}   pos: ${(pos / 1000).toFixed(1)}s / ${(dur / 1000).toFixed(1)}s`,
      `track:    ${s.track?.name ?? "—"}`,
      `lyrics:   type=${lastLyricsInfo.type}  source=${lastLyricsInfo.source}  lines=${lastLyricsInfo.lines}  translit=${lastLyricsInfo.translit}`,
    ].join("\n");
  }, 300);
}

void main().then(() => {
  if (new URLSearchParams(window.location.search).has("debug")) startDebug();
});
