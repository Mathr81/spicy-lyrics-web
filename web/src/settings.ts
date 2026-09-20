// Minimal standalone settings panel. The extension's settings live in a
// Spicetify-only panel (spcr-settings); here we expose the handful of options
// that are meaningful in the browser build, wired to the same reused nanostores
// so they persist and drive the engine identically.
import {
  $simpleLyricsMode,
  $minimalLyricsMode,
  $skipSpicyFont,
  $playbackOffset,
} from "@src/utils/stores.ts";
import {
  isWakeLockEnabled,
  setWakeLockEnabled,
  wakeLockSupported,
} from "./wakelock.ts";

export interface SettingsCallbacks {
  getPage: () => HTMLElement | null;
  // Re-render the current lyrics (options that change the layout need a re-apply).
  reapply: () => void;
}

export interface SettingsHandle {
  open: () => void;
}

interface ToggleDef {
  label: string;
  desc: string;
  get: () => boolean;
  set: (v: boolean) => void;
}

// The lyric clock corrects for network latency and for a typical audio output
// delay, but it cannot know this listener's: Bluetooth headphones alone add
// 150-300ms, and it varies per device. This is the dial for that last gap.
const OFFSET_RANGE_MS = 1000;
const OFFSET_STEP_MS = 25;

export function setupSettings(cb: SettingsCallbacks): SettingsHandle {
  // The Spicy Lyrics font is on unless explicitly skipped; keep the page class in
  // sync now and whenever the store changes.
  const applyFont = () =>
    cb.getPage()?.classList.toggle("UseSpicyFont", !$skipSpicyFont.get());
  applyFont();

  const toggles: ToggleDef[] = [
    {
      label: "Police Spicy Lyrics",
      desc: "Utiliser la police d'origine de l'extension.",
      get: () => !$skipSpicyFont.get(),
      set: (v) => {
        $skipSpicyFont.set(!v);
        applyFont();
      },
    },
    {
      label: "Mode paroles simples",
      desc: "Rendu épuré, sans animation lettre par lettre.",
      get: () => $simpleLyricsMode.get(),
      set: (v) => {
        $simpleLyricsMode.set(v);
        cb.reapply();
      },
    },
    {
      label: "Mode minimal",
      desc: "Masque les éléments décoratifs autour des paroles.",
      get: () => $minimalLyricsMode.get(),
      set: (v) => {
        $minimalLyricsMode.set(v);
        cb.getPage()?.classList.toggle("MinimalLyricsMode", v);
        cb.reapply();
      },
    },
  ];

  // Only offered where the Screen Wake Lock API exists (Safari 16.4+, current
  // Chromium); elsewhere the row would be a switch that does nothing.
  if (wakeLockSupported()) {
    toggles.push({
      label: "Garder l'écran allumé",
      desc: "Empêche la mise en veille pendant la lecture.",
      get: isWakeLockEnabled,
      set: setWakeLockEnabled,
    });
  }

  // Reflect persisted state on load.
  cb.getPage()?.classList.toggle("SimpleLyricsMode", $simpleLyricsMode.get());
  cb.getPage()?.classList.toggle("MinimalLyricsMode", $minimalLyricsMode.get());

  let overlay: HTMLElement | null = null;

  function buildRow(def: ToggleDef): HTMLElement {
    const row = document.createElement("label");
    row.className = "sl-settings-row";
    row.innerHTML = `
      <span class="sl-settings-text">
        <span class="sl-settings-label"></span>
        <span class="sl-settings-desc"></span>
      </span>
      <span class="sl-settings-switch" role="switch"><span class="sl-settings-knob"></span></span>`;
    row.querySelector<HTMLElement>(".sl-settings-label")!.textContent = def.label;
    row.querySelector<HTMLElement>(".sl-settings-desc")!.textContent = def.desc;
    const sw = row.querySelector<HTMLElement>(".sl-settings-switch")!;
    const sync = () => {
      const on = def.get();
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-checked", String(on));
    };
    sync();
    row.addEventListener("click", (e) => {
      e.preventDefault();
      def.set(!def.get());
      sync();
    });
    return row;
  }

  /**
   * The lyric sync offset, in milliseconds. Positive holds the lyrics back,
   * negative runs them early — the same sign convention as the engine's
   * $playbackOffset, which this writes straight into.
   */
  function buildOffsetRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-settings-row sl-settings-row-stacked";
    row.innerHTML = `
      <span class="sl-settings-text">
        <span class="sl-settings-label"></span>
        <span class="sl-settings-desc"></span>
      </span>
      <span class="sl-settings-slider">
        <input type="range" aria-label="Décalage des paroles">
        <button class="sl-settings-reset" type="button">Réinitialiser</button>
      </span>`;
    row.querySelector<HTMLElement>(".sl-settings-label")!.textContent =
      "Décalage des paroles";
    const desc = row.querySelector<HTMLElement>(".sl-settings-desc")!;
    const input = row.querySelector<HTMLInputElement>("input")!;
    input.min = String(-OFFSET_RANGE_MS);
    input.max = String(OFFSET_RANGE_MS);
    input.step = String(OFFSET_STEP_MS);

    const sync = () => {
      const value = $playbackOffset.get();
      input.value = String(value);
      desc.textContent =
        value === 0
          ? "Aligné sur la lecture. Glissez vers la droite si les paroles passent trop tôt."
          : value > 0
            ? `Paroles retardées de ${value} ms.`
            : `Paroles avancées de ${-value} ms.`;
    };
    sync();

    input.addEventListener("input", () => {
      $playbackOffset.set(Number(input.value));
      sync();
    });
    row.querySelector<HTMLElement>(".sl-settings-reset")!.addEventListener("click", () => {
      $playbackOffset.set(0);
      sync();
    });
    return row;
  }

  function open(): void {
    if (overlay) {
      overlay.hidden = false;
      return;
    }
    overlay = document.createElement("div");
    overlay.className = "sl-settings-overlay";
    const card = document.createElement("div");
    card.className = "sl-settings-card";
    const title = document.createElement("div");
    title.className = "sl-settings-title";
    title.textContent = "Réglages";
    card.appendChild(title);
    for (const def of toggles) card.appendChild(buildRow(def));
    card.appendChild(buildOffsetRow());
    const close = document.createElement("button");
    close.className = "sl-settings-close";
    close.textContent = "Fermer";
    close.addEventListener("click", () => {
      if (overlay) overlay.hidden = true;
    });
    card.appendChild(close);
    overlay.appendChild(card);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && overlay) overlay.hidden = true;
    });
    document.body.appendChild(overlay);
  }

  return { open };
}
