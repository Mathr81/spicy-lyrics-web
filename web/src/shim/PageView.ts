// Browser shim for `src/components/Pages/PageView.ts`.
//
// The engine reads the live `PageContainer` binding to locate `.LyricsContent`,
// `.ContentBox`, etc. Our entry builds the identical DOM and registers it here.

export let PageContainer: HTMLElement | null = null;
export let IsCardMode = false;

export function setPageContainer(el: HTMLElement | null): void {
  PageContainer = el;
}

export const GetPageRoot = (): HTMLElement | null =>
  document.getElementById("SpicyLyricsRoot");

export function Compactify(_el?: HTMLElement): void {
  /* no-op: the standalone page has a single fixed layout */
}

export const Tooltips: Record<string, { destroy?: () => void } | null> = {};

const PageView = {
  IsOpened: true,
  IsTippyCapable: false,
  AppendViewControls: (_reAppend = false): void => {
    /* view controls are owned by the standalone UI shell */
  },
  Open: async (): Promise<void> => {},
  Destroy: async (): Promise<void> => {},
};

export default PageView;
