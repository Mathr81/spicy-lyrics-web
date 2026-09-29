// The lyric sync control — the setting that gets touched most, so it is not
// buried in the settings card: a floating bar over the bottom of the page, so
// the lyrics stay visible while it is being adjusted.
//
// $playbackOffset (ms, persisted by the engine's store): positive holds the
// lyrics back, negative runs them early. The UI speaks in those terms —
// "plus tôt" / "plus tard" — rather than in signs.
//
// Also on the keyboard, anywhere on the page: [ and ] nudge by 10 ms, with
// Shift by 100 ms, and \ resets. A small readout confirms each change when the
// bar is closed.
import { $playbackOffset } from "@src/utils/stores.ts";

const RANGE_MS = 2000;
const FINE_STEP_MS = 10;
const COARSE_STEP_MS = 100;
// Holding a nudge button repeats it, after a pause long enough for a tap.
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 70;
const TOAST_MS = 1400;

export interface SyncHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const clamp = (v: number) => Math.max(-RANGE_MS, Math.min(RANGE_MS, Math.round(v)));

function setOffset(v: number): void {
  $playbackOffset.set(clamp(v));
}

function formatValue(v: number): string {
  if (v === 0) return "0 ms";
  return `${v > 0 ? "+" : "−"}${Math.abs(v)} ms`;
}

function describe(v: number): string {
  if (v === 0) return "Synchro d'origine";
  return v > 0 ? "Paroles retardées" : "Paroles avancées";
}

export function setupSync(root: HTMLElement): SyncHandle {
  const bar = document.createElement("div");
  bar.className = "sl-sync";
  bar.hidden = true;
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "Synchro des paroles");
  bar.innerHTML = `
    <div class="sl-sync-head">
      <span class="sl-sync-title">Synchro des paroles</span>
      <button class="sl-sync-close" type="button" aria-label="Fermer">✕</button>
    </div>
    <div class="sl-sync-main">
      <button class="sl-sync-nudge" type="button" data-step="${-COARSE_STEP_MS}" aria-label="${COARSE_STEP_MS} ms plus tôt">«<small>${COARSE_STEP_MS}</small></button>
      <button class="sl-sync-nudge" type="button" data-step="${-FINE_STEP_MS}" aria-label="${FINE_STEP_MS} ms plus tôt">‹<small>${FINE_STEP_MS}</small></button>
      <div class="sl-sync-readout" aria-live="polite">
        <span class="sl-sync-value"></span>
        <span class="sl-sync-desc"></span>
      </div>
      <button class="sl-sync-nudge" type="button" data-step="${FINE_STEP_MS}" aria-label="${FINE_STEP_MS} ms plus tard">›<small>${FINE_STEP_MS}</small></button>
      <button class="sl-sync-nudge" type="button" data-step="${COARSE_STEP_MS}" aria-label="${COARSE_STEP_MS} ms plus tard">»<small>${COARSE_STEP_MS}</small></button>
    </div>
    <div class="sl-sync-scale">
      <span>Plus tôt</span>
      <input type="range" min="${-RANGE_MS}" max="${RANGE_MS}" step="${FINE_STEP_MS}" aria-label="Décalage des paroles">
      <span>Plus tard</span>
    </div>
    <div class="sl-sync-foot">
      <span class="sl-sync-hint">Les paroles arrivent trop tôt ? → Plus tard.</span>
      <button class="sl-sync-reset" type="button">Réinitialiser</button>
    </div>`;
  root.appendChild(bar);

  const toast = document.createElement("div");
  toast.className = "sl-sync-toast";
  root.appendChild(toast);
  let toastTimer: number | undefined;

  const valueEl = bar.querySelector<HTMLElement>(".sl-sync-value")!;
  const descEl = bar.querySelector<HTMLElement>(".sl-sync-desc")!;
  const input = bar.querySelector<HTMLInputElement>("input")!;
  const reset = bar.querySelector<HTMLButtonElement>(".sl-sync-reset")!;

  const render = (v: number) => {
    valueEl.textContent = formatValue(v);
    descEl.textContent = describe(v);
    bar.classList.toggle("is-zero", v === 0);
    reset.disabled = v === 0;
    if (document.activeElement !== input) input.value = String(v);
  };
  $playbackOffset.subscribe(render);

  input.addEventListener("input", () => setOffset(Number(input.value)));
  reset.addEventListener("click", () => setOffset(0));
  bar.querySelector(".sl-sync-close")!.addEventListener("click", () => close());

  // Nudge buttons: a tap steps once, holding repeats.
  for (const btn of bar.querySelectorAll<HTMLButtonElement>(".sl-sync-nudge")) {
    const step = Number(btn.dataset.step);
    let delay: number | undefined;
    let repeat: number | undefined;
    const stop = () => {
      window.clearTimeout(delay);
      window.clearInterval(repeat);
      btn.classList.remove("Pressed");
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // no focus ring flash, no text selection on long-press
      btn.classList.add("Pressed");
      setOffset($playbackOffset.get() + step);
      delay = window.setTimeout(() => {
        repeat = window.setInterval(() => setOffset($playbackOffset.get() + step), REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS);
    });
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    // Keyboard activation (Enter/Space) arrives as a click without pointer events.
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) setOffset($playbackOffset.get() + step);
    });
  }

  function showToast(): void {
    toast.textContent = `Synchro : ${formatValue($playbackOffset.get())}`;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), TOAST_MS);
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    let next: number | null = null;
    const step = e.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS;
    if (e.code === "BracketLeft") next = $playbackOffset.get() - step;
    else if (e.code === "BracketRight") next = $playbackOffset.get() + step;
    else if (e.code === "Backslash") next = 0;
    else if (e.key === "Escape" && !bar.hidden) {
      close();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setOffset(next);
    if (bar.hidden) showToast();
  });

  function open(): void {
    bar.hidden = false;
    toast.classList.remove("visible");
  }
  function close(): void {
    bar.hidden = true;
  }

  return { open, close, toggle: () => (bar.hidden ? open() : close()) };
}
