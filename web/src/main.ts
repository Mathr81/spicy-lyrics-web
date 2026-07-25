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
import { handleRedirectCallback, isLoggedIn, login, logout } from "./spotify/auth.ts";
import {
  initPlayer,
  onUpdate,
  togglePlay,
  skipNext,
  skipPrev,
  play,
  type AdapterSnapshot,
} from "./spotify/player.ts";
import { searchTracks, type SimpleTrack } from "./spotify/api.ts";
import { fetchLyrics } from "./lyrics/fetch.ts";
import { applyLyrics, clearLyrics } from "./lyrics/apply.ts";
import { buildPage, updateNowBar, showLoader, showNotice } from "./renderer.ts";
import { renderShell, type ShellHandle } from "./ui.ts";
import { $romanization } from "@src/utils/uiState.ts";
import Fullscreen from "./shim/Fullscreen.ts";

const NOTICES: Record<string, string> = {
  "not-found": "Aucune parole disponible pour ce titre.",
  queued: "Votre requête est dans la file d'attente — les paroles arrivent…",
  error: "Une erreur est survenue lors du chargement des paroles.",
  "no-auth": "Connexion Spotify requise.",
};

let currentTrackUri: string | null = null;
let lastLyricsData: any = null;
let shell: ShellHandle;

async function main(): Promise<void> {
  const root = document.getElementById("SpicyLyricsRoot") as HTMLElement;
  buildPage(root);

  shell = renderShell(root, {
    onLogin: () => void login(),
    onLogout: () => {
      logout();
      window.location.reload();
    },
    onSearch: (q) => searchTracks(q),
    onPick: async (track) => {
      try {
        await play(track.uri);
      } catch (err) {
        console.warn("[SpicyLyrics] play failed", err);
      }
      // Load lyrics immediately; playback state will catch up.
      currentTrackUri = track.uri;
      updateNowBar(track);
      void loadLyrics(track);
    },
    onToggle: () => void togglePlay(),
    onNext: () => void skipNext(),
    onPrev: () => void skipPrev(),
    onToggleRomanization: () => {
      const next = !$romanization.get();
      $romanization.set(next);
      if (lastLyricsData) applyLyrics(lastLyricsData, next);
    },
    onToggleFullscreen: () => Fullscreen.Toggle(),
  });

  // Offline preview: ?demo drives the engine with a built-in sample.
  if (new URLSearchParams(window.location.search).has("demo")) {
    const { startDemo } = await import("./demo.ts");
    shell.setStatus("Mode démo — connectez-vous pour vos vraies paroles Spotify.");
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
    shell.setStatus("⚠ Configurez votre Client ID Spotify dans web/src/config.ts");
  }

  if (!isLoggedIn()) {
    shell.setLoggedIn(false);
    return;
  }

  shell.setLoggedIn(true);
  const mode = await initPlayer(true);
  shell.setMode(mode, null);

  onUpdate(handleSnapshot);
}

function handleSnapshot(snap: AdapterSnapshot): void {
  shell.setPlaying(snap.isPlaying);
  shell.setMode(snap.mode, snap.deviceName);
  updateNowBar(snap.track);

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
    shell.setRomanizationAvailable(false);
    showNotice(NOTICES[res.reason] ?? NOTICES.error);
    return;
  }

  lastLyricsData = res.data;
  shell.setRomanizationAvailable(res.data.HasTransliterations === true);
  applyLyrics(res.data, romanize);
}

void main();
