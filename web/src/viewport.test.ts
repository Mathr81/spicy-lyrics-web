// Run with: bun test web/src/viewport.test.ts
import { expect, test } from "bun:test";
import { isWindowed } from "./viewport.ts";

test("full screen in either orientation, however iOS orders the screen's sides", () => {
  expect(isWindowed(1024, 1366, 1366)).toBe(false);
  expect(isWindowed(1024, 1366, 1024)).toBe(false);
  expect(isWindowed(1366, 1024, 1024)).toBe(false);
});

test("Split View panes and resized windows are windows", () => {
  expect(isWindowed(1024, 1366, 375)).toBe(true);
  expect(isWindowed(1024, 1366, 678)).toBe(true);
  expect(isWindowed(1024, 1366, 1100)).toBe(true);
});
