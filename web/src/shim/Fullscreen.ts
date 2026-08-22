// Browser shim for `src/components/Utils/Fullscreen.ts`.
//
// The standalone page IS the fullscreen lyrics view: the `.Fullscreen`
// composition class is applied permanently by the renderer, and `CinemaViewOpen`
// is kept true so the reused engine treats it as a fullscreen/cinema layout.
// The ⛶ button toggles only the *native* browser fullscreen, never the
// composition class.

// iPad Safari implements the Fullscreen API only under the `webkit` prefix
// (`webkitRequestFullscreen` / `webkitExitFullscreen` / `webkitFullscreenElement`);
// the standard names are absent. Resolve both so the ⛶ control works there too.
// (iPhone Safari supports fullscreen for <video> only, so nothing to enter there;
// and "Add to Home Screen" standalone mode exposes no Fullscreen API at all.)
type AnyEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type AnyDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

const doc = document as AnyDoc;

export function fullscreenElement(): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function requestFullscreen(el: AnyEl): Promise<void> {
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (req) await req.call(el);
}

async function exitFullscreen(): Promise<void> {
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (exit) await exit.call(doc);
}

const Fullscreen = {
  IsOpen: false, // tracks native browser fullscreen
  CinemaViewOpen: true, // standalone is always the fullscreen composition
  async Open(): Promise<void> {
    const el =
      (document.getElementById("SpicyLyricsRoot") as AnyEl | null) ??
      (document.documentElement as AnyEl);
    try {
      await requestFullscreen(el);
      Fullscreen.IsOpen = true;
    } catch {
      /* ignore */
    }
  },
  async Close(): Promise<void> {
    try {
      if (fullscreenElement()) await exitFullscreen();
    } catch {
      /* ignore */
    }
    Fullscreen.IsOpen = false;
  },
  Toggle(): void {
    if (fullscreenElement()) void Fullscreen.Close();
    else void Fullscreen.Open();
  },
};

export const ExitFullscreenElement = async (): Promise<void> => {
  if (fullscreenElement()) await exitFullscreen();
};

export const EnterSpicyLyricsFullscreen = async (): Promise<void> => {
  try {
    if (!fullscreenElement())
      await requestFullscreen(document.documentElement as AnyEl);
  } catch {
    /* ignore */
  }
};

export const CleanupMediaBox = (): void => {};

const syncOpen = () => {
  Fullscreen.IsOpen = !!fullscreenElement();
};
document.addEventListener("fullscreenchange", syncOpen);
document.addEventListener("webkitfullscreenchange", syncOpen);

export default Fullscreen;
