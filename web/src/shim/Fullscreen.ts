// Browser shim for `src/components/Utils/Fullscreen.ts`.
//
// The standalone page IS the fullscreen lyrics view: the `.Fullscreen`
// composition class is applied permanently by the renderer, and `CinemaViewOpen`
// is kept true so the reused engine treats it as a fullscreen/cinema layout.
// The ⛶ button toggles only the *native* browser fullscreen, never the
// composition class.

const Fullscreen = {
  IsOpen: false, // tracks native browser fullscreen
  CinemaViewOpen: true, // standalone is always the fullscreen composition
  async Open(): Promise<void> {
    const el =
      (document.getElementById("SpicyLyricsRoot") as HTMLElement | null) ??
      document.documentElement;
    try {
      await el?.requestFullscreen?.();
      Fullscreen.IsOpen = true;
    } catch {
      /* ignore */
    }
  },
  async Close(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
    Fullscreen.IsOpen = false;
  },
  Toggle(): void {
    if (document.fullscreenElement) void Fullscreen.Close();
    else void Fullscreen.Open();
  },
};

export const ExitFullscreenElement = async (): Promise<void> => {
  if (document.fullscreenElement) await document.exitFullscreen();
};

export const EnterSpicyLyricsFullscreen = async (): Promise<void> => {
  try {
    if (!document.fullscreenElement)
      await document.documentElement.requestFullscreen();
  } catch {
    /* ignore */
  }
};

export const CleanupMediaBox = (): void => {};

document.addEventListener("fullscreenchange", () => {
  Fullscreen.IsOpen = !!document.fullscreenElement;
});

export default Fullscreen;
