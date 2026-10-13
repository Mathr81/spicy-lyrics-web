// The Android app's shell (android/…/MainActivity.java), as the page sees it.
//
// `shell` is undefined in a browser. Every method is optional too: the page
// updates with each web deploy, the installed app only when it updates itself,
// so the page can be talking to an older shell that lacks the newer ones.
export interface NativeShell {
  /** Hold the screen on. A WebView has no Wake Lock API. */
  keepAwake?(on: boolean): void;
  /** Something is playing: leaving the app then floats it over the next one. */
  setPlaying?(on: boolean): void;
  haptic?(): void;
  /** Whether the app may read Spotify's media session on this phone. */
  linkGranted?(): boolean;
  /** Open the system screen where the user grants or withdraws that. */
  requestLink?(): void;
  /** Start (or restart) reporting the session through `window.__spicyNative`. */
  subscribe?(): void;
  /** Act on Spotify's session. False when there is none to act on. */
  transport?(action: "play" | "pause" | "next" | "prev" | "seek", positionMs: number): boolean;
}

export const shell = (window as any).SpicyNative as NativeShell | undefined;

/** Spotify's media session, as the shell reports it. */
export interface NativeSession {
  playing: boolean;
  positionMs: number;
  title: string;
}

/** The app is floating over another one (Android picture-in-picture). */
export const isFloating = () => document.documentElement.classList.contains("sl-native-pip");

const floatingListeners = new Set<() => void>();

export function onFloatingChange(cb: () => void): void {
  floatingListeners.add(cb);
}

let playing: boolean | null = null;

export function setNativePlaying(next: boolean): void {
  if (next === playing) return;
  playing = next;
  shell?.setPlaying?.(next);
}

export function initNative(): void {
  if (!shell) return;
  // The app floating over another one (Android picture-in-picture): the page
  // class the small layout keys on.
  (window as any).__spicyPip = (on: boolean) => {
    document.documentElement.classList.toggle("sl-native-pip", on);
    floatingListeners.forEach((cb) => cb());
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      const control = "button, .PlaybackControl, .PrevTrack, .NextTrack, .sl-settings-row";
      if ((e.target as Element).closest?.(control)) shell.haptic?.();
    },
    true
  );
}
