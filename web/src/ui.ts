// Minimal control shell layered over the lyrics page: login, track search,
// playback controls, mode/device banner, romanization + fullscreen toggles.
import type { SimpleTrack } from "./spotify/api.ts";
import type { PlaybackMode } from "./spotify/player.ts";

export interface ShellCallbacks {
  onLogin: () => void;
  onLogout: () => void;
  onSearch: (query: string) => Promise<SimpleTrack[]>;
  onPick: (track: SimpleTrack) => void;
  onToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  onToggleRomanization: () => void;
  onToggleFullscreen: () => void;
}

export interface ShellHandle {
  setLoggedIn: (v: boolean) => void;
  setPlaying: (v: boolean) => void;
  setMode: (mode: PlaybackMode, device: string | null) => void;
  setRomanizationAvailable: (v: boolean) => void;
  setStatus: (text: string) => void;
}

const icon = {
  play: "▶",
  pause: "⏸",
  prev: "⏮",
  next: "⏭",
  search: "🔎",
  full: "⛶",
};

export function renderShell(root: HTMLElement, cb: ShellCallbacks): ShellHandle {
  const bar = document.createElement("div");
  bar.className = "sl-shell";
  bar.innerHTML = `
    <div class="sl-shell-row">
      <button class="sl-btn sl-login" type="button">Se connecter à Spotify</button>
      <div class="sl-search" hidden>
        <input class="sl-search-input" type="search" placeholder="Rechercher un titre…" autocomplete="off" />
        <div class="sl-results" hidden></div>
      </div>
      <div class="sl-controls" hidden>
        <button class="sl-btn sl-prev" title="Précédent">${icon.prev}</button>
        <button class="sl-btn sl-toggle" title="Lecture/Pause">${icon.play}</button>
        <button class="sl-btn sl-next" title="Suivant">${icon.next}</button>
        <button class="sl-btn sl-rom" title="Romanisation" hidden>あ→A</button>
        <button class="sl-btn sl-full" title="Plein écran">${icon.full}</button>
        <button class="sl-btn sl-logout" title="Se déconnecter">⏻</button>
      </div>
    </div>
    <div class="sl-status"></div>
  `;
  root.appendChild(bar);

  const $ = <T extends HTMLElement>(sel: string) => bar.querySelector<T>(sel)!;
  const loginBtn = $(".sl-login");
  const searchWrap = $(".sl-search");
  const searchInput = $<HTMLInputElement>(".sl-search-input");
  const results = $(".sl-results");
  const controls = $(".sl-controls");
  const toggleBtn = $(".sl-toggle");
  const romBtn = $(".sl-rom");
  const statusEl = $(".sl-status");

  loginBtn.addEventListener("click", cb.onLogin);
  $(".sl-logout").addEventListener("click", cb.onLogout);
  toggleBtn.addEventListener("click", cb.onToggle);
  $(".sl-next").addEventListener("click", cb.onNext);
  $(".sl-prev").addEventListener("click", cb.onPrev);
  romBtn.addEventListener("click", cb.onToggleRomanization);
  $(".sl-full").addEventListener("click", cb.onToggleFullscreen);

  let searchTimer: number | undefined;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    searchTimer = window.setTimeout(async () => {
      try {
        const tracks = await cb.onSearch(q);
        renderResults(tracks);
      } catch (err) {
        console.warn(err);
      }
    }, 300);
  });

  function renderResults(tracks: SimpleTrack[]): void {
    results.innerHTML = "";
    if (tracks.length === 0) {
      results.hidden = true;
      return;
    }
    for (const t of tracks) {
      const row = document.createElement("button");
      row.className = "sl-result";
      row.innerHTML = `
        <img src="${t.cover ?? ""}" alt="" />
        <span class="sl-result-meta">
          <span class="sl-result-name">${escapeHtml(t.name)}</span>
          <span class="sl-result-artist">${escapeHtml(t.artists.map((a) => a.name).join(", "))}</span>
        </span>`;
      row.addEventListener("click", () => {
        cb.onPick(t);
        results.hidden = true;
        searchInput.value = "";
      });
      results.appendChild(row);
    }
    results.hidden = false;
  }

  document.addEventListener("click", (e) => {
    if (!searchWrap.contains(e.target as Node)) results.hidden = true;
  });

  return {
    setLoggedIn(v) {
      loginBtn.hidden = v;
      searchWrap.hidden = !v;
      controls.hidden = !v;
    },
    setPlaying(v) {
      toggleBtn.textContent = v ? icon.pause : icon.play;
    },
    setMode(mode, device) {
      const label =
        mode === "sdk"
          ? "Lecture dans cet onglet"
          : device
            ? `Miroir de : ${device}`
            : "En attente d'un appareil Spotify actif…";
      statusEl.dataset.mode = mode;
      statusEl.textContent = label;
    },
    setRomanizationAvailable(v) {
      romBtn.hidden = !v;
    },
    setStatus(text) {
      statusEl.textContent = text;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
