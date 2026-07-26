// Thin Spotify Web API client used for search, reading playback state (Connect
// mirror mode) and transferring/controlling playback.
import { getAccessToken } from "./auth.ts";

const BASE = "https://api.spotify.com/v1";

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export interface SimpleTrack {
  uri: string;
  id: string;
  name: string;
  artists: { name: string; uri: string; type: "artist" }[];
  cover: string | null;
  durationMs: number;
}

function coverFrom(images: { url: string; width: number }[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  // Largest first is Spotify's default order.
  return images[0].url;
}

function toSimpleTrack(item: any): SimpleTrack {
  return {
    uri: item.uri,
    id: item.id,
    name: item.name,
    artists: (item.artists ?? []).map((a: any) => ({
      name: a.name,
      uri: a.uri,
      type: "artist" as const,
    })),
    cover: coverFrom(item.album?.images),
    durationMs: item.duration_ms ?? 0,
  };
}

export async function searchTracks(query: string): Promise<SimpleTrack[]> {
  if (!query.trim()) return [];
  const res = await req(`/search?type=track&limit=20&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const json = await res.json();
  return (json.tracks?.items ?? []).map(toSimpleTrack);
}

export type RepeatMode = "off" | "context" | "track";

export interface PlaybackSnapshot {
  isPlaying: boolean;
  progressMs: number;
  track: SimpleTrack | null;
  deviceName: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
}

/** GET /me/player — the source of truth for Spotify Connect mirror mode. */
export async function getPlaybackState(): Promise<PlaybackSnapshot | null> {
  const res = await req("/me/player");
  if (res.status === 204) return null; // nothing playing
  if (!res.ok) throw new Error(`Playback state failed: ${res.status}`);
  const json = await res.json();
  if (!json || !json.item) return null;
  return {
    isPlaying: !!json.is_playing,
    progressMs: json.progress_ms ?? 0,
    track: toSimpleTrack(json.item),
    deviceName: json.device?.name ?? null,
    shuffle: !!json.shuffle_state,
    repeat: (json.repeat_state ?? "off") as RepeatMode,
  };
}

export async function transferPlayback(deviceId: string, play = true): Promise<void> {
  await req("/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}

export async function playTrack(uri: string, deviceId?: string): Promise<void> {
  const q = deviceId ? `?device_id=${deviceId}` : "";
  await req(`/me/player/play${q}`, {
    method: "PUT",
    body: JSON.stringify({ uris: [uri] }),
  });
}

export async function pause(): Promise<void> {
  await req("/me/player/pause", { method: "PUT" });
}

export async function resume(): Promise<void> {
  await req("/me/player/play", { method: "PUT" });
}

export async function seek(positionMs: number): Promise<void> {
  await req(`/me/player/seek?position_ms=${Math.round(positionMs)}`, { method: "PUT" });
}

export async function next(): Promise<void> {
  await req("/me/player/next", { method: "POST" });
}

export async function previous(): Promise<void> {
  await req("/me/player/previous", { method: "POST" });
}

export async function setShuffle(state: boolean): Promise<void> {
  await req(`/me/player/shuffle?state=${state}`, { method: "PUT" });
}

// state: "off" | "context" | "track"
export async function setRepeat(state: "off" | "context" | "track"): Promise<void> {
  await req(`/me/player/repeat?state=${state}`, { method: "PUT" });
}
