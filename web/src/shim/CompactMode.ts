// Browser shim for `src/components/Utils/CompactMode.ts`.
// Compact mode is a fullscreen-only layout tweak; the standalone page keeps the
// standard centered layout, so this is effectively a constant `false`.
import { PageContainer } from "./PageView.ts";

let compact = false;

export function IsCompactMode(): boolean {
  return compact;
}

export function EnableCompactMode(): void {
  compact = true;
  PageContainer?.classList.add("CompactMode");
}

export function DisableCompactMode(): void {
  compact = false;
  PageContainer?.classList.remove("CompactMode");
}
