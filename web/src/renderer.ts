// Builds the same `#SpicyLyricsPage` DOM the extension's PageView creates, wires
// it into the reused engine (PageContainer registration, scroll loop, the
// `lyrics:apply` scroll-init that PageView normally owns) and exposes helpers to
// update the NowBar metadata and show notices.
import { setPageContainer } from "./shim/PageView.ts";
import { $lyricsContainerExists } from "@src/utils/stores.ts";
import Global from "@src/components/Global/Global.ts";
import { ScrollingIntervalTime } from "@src/utils/Lyrics/lyrics.ts";
import { IntervalManager } from "@src/utils/IntervalManager.ts";
import {
  InitializeScrollEvents,
  CleanupScrollEvents,
  ScrollToActiveLine,
} from "@src/utils/Scrolling/ScrollToActiveLine.ts";
import { ScrollSimplebar } from "@src/utils/Scrolling/Simplebar/ScrollSimplebar.ts";
import { triggerRemeasureLV } from "@src/utils/Lyrics/LyricsVirtualizer.ts";
import ApplyDynamicBackground from "./shim/dynamicBackground.ts";
import type { SimpleTrack } from "./spotify/api.ts";

// iOS/iPadOS Safari throttles `scroll-behavior: smooth`, which makes the
// active-line auto-scroll crawl and the lyrics drift. Detect it so the CSS can
// switch that container to instant scrolling.
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);

const PAGE_HTML = `
  <div class="ContentBox">
    <div class="NowBar LeftSide Active">
      <div class="CenteredView">
        <div class="Header">
          <div class="MediaBox">
            <div class="MediaContent"></div>
            <div class="MediaImageContainer">
              <div class="fi_FromImage ib_ImageBox"></div>
              <div class="ti_ToImage ib_ImageBox"></div>
            </div>
          </div>
          <div class="Metadata">
            <div class="SongName"><span></span></div>
            <div class="Artists"><span></span></div>
          </div>
        </div>
      </div>
    </div>
    <div class="LyricsContainer">
      <div class="loaderContainer">
        <div id="DotLoader"></div>
      </div>
      <div class="LyricsContent ScrollbarScrollable"></div>
    </div>
    <div class="ViewControls"></div>
  </div>
`;

let page: HTMLElement | null = null;

export function buildPage(root: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.id = "SpicyLyricsPage";
  // The standalone page is the extension's fullscreen lyrics composition.
  el.classList.add("SpicyRenderer", "UseSpicyFont", "Fullscreen");
  if (IS_IOS) el.classList.add("iOS");
  el.innerHTML = PAGE_HTML;
  root.appendChild(el);

  page = el;
  setPageContainer(el);
  $lyricsContainerExists.set(true);

  // Continuous auto-scroll to the active line (app.tsx runs this globally).
  new IntervalManager(ScrollingIntervalTime, () => {
    if (ScrollSimplebar) ScrollToActiveLine(ScrollSimplebar);
  }).Start();

  // PageView normally (re)binds scroll events when lyrics apply. Replicate it.
  Global.Event.listen("lyrics:not-apply", () => {
    CleanupScrollEvents();
  });
  Global.Event.listen("lyrics:apply", ({ Type }: { Type: string }) => {
    CleanupScrollEvents();
    if (!Type || Type === "Static") return;
    if (ScrollSimplebar) InitializeScrollEvents(ScrollSimplebar);
    setTimeout(() => triggerRemeasureLV(), 1000);
    setTimeout(() => triggerRemeasureLV(), 1500);
  });

  return el;
}

export function getContentBox(): HTMLElement | null {
  return page?.querySelector<HTMLElement>(".ContentBox") ?? null;
}

let lastCover: string | null = null;

export function updateNowBar(track: SimpleTrack | null): void {
  if (!page || !track) return;
  const songName = page.querySelector<HTMLElement>(".Metadata .SongName span");
  const artists = page.querySelector<HTMLElement>(".Metadata .Artists span");
  const from = page.querySelector<HTMLElement>(".MediaImageContainer .fi_FromImage");
  const to = page.querySelector<HTMLElement>(".MediaImageContainer .ti_ToImage");

  if (songName) songName.textContent = track.name ?? "";
  if (artists) artists.textContent = track.artists.map((a) => a.name).join(", ");

  if (track.cover && track.cover !== lastCover) {
    lastCover = track.cover;
    if (to) to.style.backgroundImage = `url("${track.cover}")`;
    if (from) from.style.backgroundImage = `url("${track.cover}")`;
    const contentBox = getContentBox();
    if (contentBox) void ApplyDynamicBackground(contentBox, "lpagebg");
  }
}

export function showLoader(show: boolean): void {
  const loader = page?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  loader?.classList.toggle("active", show);
}

export function showNotice(text: string): void {
  const container = page?.querySelector<HTMLElement>(".LyricsContainer .LyricsContent");
  if (!container) return;
  container.innerHTML = `
    <div class="LyricsNotice">
      <p class="notice-descriptor">${text}</p>
    </div>`;
}
