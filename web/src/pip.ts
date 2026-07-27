// Document Picture-in-Picture — same idea as the extension's PopupLyrics: open a
// PiP window, copy the stylesheets/fonts over, and show the lyrics page in it.
// Here we move the live #SpicyLyricsPage node into the PiP window (the animator
// loop keeps driving it cross-document) and move it back on close.
//
// The Document PiP API is Chromium-only (desktop Chrome/Edge) — unavailable on
// Safari/iOS, so the control is hidden where it isn't supported.

let pipWin: any = null;
let placeholder: Comment | null = null;

export function pipSupported(): boolean {
  return "documentPictureInPicture" in window;
}

export function isPipOpen(): boolean {
  return !!pipWin;
}

function copyStyles(target: Document): void {
  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')
  )) {
    if (node.tagName === "LINK") {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      // Use the resolved absolute URL so it loads inside the PiP document.
      link.href = (node as HTMLLinkElement).href;
      target.head.appendChild(link);
    } else {
      target.head.appendChild(node.cloneNode(true));
    }
  }
  const base = target.createElement("style");
  base.textContent =
    "html,body{margin:0;padding:0;height:100%;width:100%;overflow:hidden;background:#000}" +
    "#SpicyLyricsPage{position:fixed;inset:0;container-type:size}";
  target.head.appendChild(base);
}

export async function togglePip(): Promise<boolean> {
  if (pipWin) {
    pipWin.close();
    return false;
  }
  const dpip = (window as any).documentPictureInPicture;
  if (!dpip || typeof dpip.requestWindow !== "function") return false;

  pipWin = await dpip.requestWindow({ width: 440, height: 440 });
  copyStyles(pipWin.document);

  const page = document.getElementById("SpicyLyricsPage");
  if (!page) return false;

  placeholder = document.createComment("pip-page");
  page.replaceWith(placeholder);
  pipWin.document.body.appendChild(page); // adoptNode happens implicitly

  pipWin.addEventListener("pagehide", restore, { once: true });
  return true;
}

function restore(): void {
  if (!pipWin) return;
  const page = pipWin.document.getElementById("SpicyLyricsPage");
  if (page) {
    if (placeholder && placeholder.parentNode) placeholder.replaceWith(page);
    else document.getElementById("SpicyLyricsRoot")?.appendChild(page);
  }
  placeholder = null;
  pipWin = null;
}
