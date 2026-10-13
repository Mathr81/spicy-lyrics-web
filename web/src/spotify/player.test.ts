// Run with: bun test web/src/spotify
import { expect, mock, test } from "bun:test";

mock.module("../config.ts", () => ({ SDK_SUPPORTED: false }));
mock.module("./auth.ts", () => ({ getAccessToken: async () => "token" }));
mock.module("../shim/SpotifyPlayer.ts", () => ({ pushPlaybackState() {}, setPlaying() {} }));

// The Android shell, which is only there in the last test.
const shellCalls: string[] = [];
(globalThis as any).SpicyNative = {
  subscribe() {},
  transport: (action: string) => shellCalls.push(action) > 0,
};

// What Spotify answers: GET /me/player, and the status of PUT /me/player/play.
let playerState: object | null = null;
let playStatus = 204;
const calls: string[] = [];

(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const path = url.replace("https://api.spotify.com/v1", "");
  calls.push(`${method} ${path}`);
  if (method === "GET") {
    return playerState
      ? new Response(JSON.stringify(playerState), { status: 200 })
      : new Response(null, { status: 204 });
  }
  return new Response(null, { status: path.startsWith("/me/player/play") ? playStatus : 204 });
};

// The mirror polls on an interval; the tests fire it by hand.
let poll: () => Promise<void> = async () => {};
(globalThis as any).window = globalThis;
(globalThis as any).setInterval = (fn: () => Promise<void>) => {
  poll = fn;
  return 0;
};

const { initPlayer, togglePlay, play, queueTrack, getSnapshot, onPlaybackError } = await import(
  "./player.ts"
);

const playingOn = (id: string) => ({
  is_playing: true,
  progress_ms: 30_000,
  device: { id, name: "iPad" },
  item: { uri: "spotify:track:1", id: "1", name: "Joli", artists: [], duration_ms: 186_000 },
});

test("pausing shows at once, and a poll still reporting the old state does not undo it", async () => {
  playerState = playingOn("d1");
  await initPlayer(false);
  await poll();
  expect(getSnapshot().isPlaying).toBe(true);

  const done = togglePlay();
  expect(getSnapshot().isPlaying).toBe(false);
  await done;
  expect(calls).toContain("PUT /me/player/pause");

  await poll(); // Spotify has not caught up yet
  expect(getSnapshot().isPlaying).toBe(false);
});

test("with no active device left, the track stays up and play goes to the device last mirrored", async () => {
  playerState = null;
  await poll();
  expect(getSnapshot().track?.name).toBe("Joli");
  expect(getSnapshot().positionMs).toBe(30_000);

  await togglePlay();
  expect(calls).toContain("PUT /me/player/play?device_id=d1");
  expect(getSnapshot().isPlaying).toBe(true);
});

test("a play Spotify refuses is reported and undone", async () => {
  await togglePlay(); // pause again
  const errors: string[] = [];
  onPlaybackError((message) => errors.push(message));

  playStatus = 404;
  await togglePlay();
  expect(getSnapshot().isPlaying).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("iPad");
});

test("playing a search result and queueing one both name the device", async () => {
  playStatus = 204;
  await play("spotify:track:2");
  await queueTrack("spotify:track:3");
  expect(calls).toContain("PUT /me/player/play?device_id=d1");
  expect(calls).toContain("POST /me/player/queue?uri=spotify%3Atrack%3A3&device_id=d1");
});

test("Android: the phone's media session is the clock and the transport", async () => {
  playerState = playingOn("d1");
  const session = (globalThis as any).__spicyNative;

  // On another title it says nothing about this track: the Web API still rules.
  session({ playing: false, positionMs: 5_000, title: "Autre" });
  await poll();
  expect(getSnapshot().isPlaying).toBe(true);
  expect(shellCalls).toHaveLength(0);

  session({ playing: false, positionMs: 90_000, title: "Joli" });
  expect(getSnapshot().isPlaying).toBe(false);
  expect(getSnapshot().positionMs).toBe(90_000);

  await poll(); // Spotify's servers still say "playing at 0:30"
  expect(getSnapshot().positionMs).toBe(90_000);

  const before = calls.length;
  await togglePlay();
  expect(shellCalls).toEqual(["play"]);
  expect(calls.length).toBe(before);
});
