// Browser shim for `src/components/Utils/Fullscreen.ts`.
// The engine only reads `IsOpen` / `CinemaViewOpen`; the UI shell owns the
// actual fullscreen toggle via the native Fullscreen API.
import { PageContainer } from "./PageView.ts";

const Fullscreen = {
  IsOpen: false,
  CinemaViewOpen: false,
  async Open(): Promise<void> {
    Fullscreen.IsOpen = true;
    PageContainer?.classList.add("Fullscreen");
    const el =
      (document.getElementById("SpicyLyricsRoot") as HTMLElement | null) ?? PageContainer;
    try {
      await el?.requestFullscreen?.();
    } catch {
      /* ignore */
    }
  },
  async Close(): Promise<void> {
    Fullscreen.IsOpen = false;
    Fullscreen.CinemaViewOpen = false;
    PageContainer?.classList.remove("Fullscreen");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  },
  Toggle(): void {
    if (Fullscreen.IsOpen) void Fullscreen.Close();
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

// Keep state in sync when the user leaves native fullscreen with Esc.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && Fullscreen.IsOpen) {
    Fullscreen.IsOpen = false;
    Fullscreen.CinemaViewOpen = false;
    PageContainer?.classList.remove("Fullscreen");
  }
});

export default Fullscreen;
