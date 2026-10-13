// Run with: bun test web/src/viewport.test.ts
import { expect, test } from "bun:test";
import { viewportGap } from "./viewport.ts";

test("full screen: the gap is the status bar, whichever way iOS reports the screen", () => {
  expect(viewportGap(1024, 1366, true, 1000)).toBe(24);
  expect(viewportGap(1366, 1024, true, 1000)).toBe(24);
  expect(viewportGap(1024, 1366, false, 1342)).toBe(24);
});

test("a full-height pane with nothing missing measures 0, not unknown", () => {
  // Split View on a landscape 13" iPad: 375 x 1024, a portrait-shaped viewport.
  expect(viewportGap(1366, 1024, true, 1024)).toBe(0);
});

test("a window that is not the screen's height cannot be measured", () => {
  expect(viewportGap(1366, 1024, true, 700)).toBeNull();
});
