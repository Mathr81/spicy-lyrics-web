// Minimal standalone settings panel. The extension's settings live in a
// Spicetify-only panel (spcr-settings); here we expose the handful of options
// that are meaningful in the browser build, wired to the same reused nanostores
// so they persist and drive the engine identically.
import {
  $simpleLyricsMode,
  $minimalLyricsMode,
  $skipSpicyFont,
  $playbackOffset,
  $smoothScrolling,
  SETTINGS_KEY,
} from "@src/utils/stores.ts";
import {
  isWakeLockEnabled,
  setWakeLockEnabled,
  wakeLockSupported,
} from "./wakelock.ts";

export interface SettingsCallbacks {
  getPage: () => HTMLElement | null;
  // Open the floating sync bar (sync.ts).
  openSync: () => void;
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

/**
 * The extension ships Smooth Scrolling off; here it is the whole point of a
 * lyrics screen on an iPad or a phone, and without it iOS jumps line to line.
 * Turn it on for anyone who has never chosen, leaving an explicit "off" alone.
 */
function defaultSmoothScrollingOn(): void {
  try {
    const blob = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (blob && typeof blob === "object" && "smoothScrolling" in blob) return;
  } catch {
    // Unreadable blob: the store fell back to its defaults too.
  }
  $smoothScrolling.set(true);
}

/**
 * Simple and minimal lyrics modes used to be offered here and are not any more.
 * Someone who had turned one on would be stuck with it and no switch to undo
 * it, so both go back to off.
 */
function retireRemovedModes(): void {
  if ($simpleLyricsMode.get()) $simpleLyricsMode.set(false);
  if ($minimalLyricsMode.get()) $minimalLyricsMode.set(false);
}

export function setupSettings(cb: SettingsCallbacks): SettingsHandle {
  defaultSmoothScrollingOn();
  retireRemovedModes();

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
      label: "Défilement fluide",
      desc: "Les paroles glissent d'une ligne à l'autre au lieu de sauter.",
      get: () => $smoothScrolling.get(),
      set: (v) => $smoothScrolling.set(v),
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
   * The sync offset lives in its own floating bar so the lyrics stay visible
   * while it is adjusted; this row shows the value and opens it.
   */
  function buildSyncRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-settings-row";
    row.innerHTML = `
      <span class="sl-settings-text">
        <span class="sl-settings-label">Synchro des paroles</span>
        <span class="sl-settings-desc"></span>
      </span>
      <button class="sl-settings-reset" type="button">Ajuster</button>`;
    const desc = row.querySelector<HTMLElement>(".sl-settings-desc")!;
    $playbackOffset.subscribe((v) => {
      desc.textContent =
        v === 0
          ? "Aucun décalage. Raccourcis : [ et ] (Maj : ×10)."
          : `Décalage actuel : ${v > 0 ? "+" : "−"}${Math.abs(v)} ms.`;
    });
    row.querySelector<HTMLElement>("button")!.addEventListener("click", () => {
      if (overlay) overlay.hidden = true;
      cb.openSync();
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
    card.appendChild(buildSyncRow());
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
