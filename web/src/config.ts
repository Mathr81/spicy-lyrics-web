// ---------------------------------------------------------------------------
// Standalone configuration.
//
// 1. Create a Spotify app at https://developer.spotify.com/dashboard
// 2. Put your app's Client ID below (or set VITE_SPOTIFY_CLIENT_ID at build time)
// 3. Add your hosting URL (exactly, no trailing slash) as a Redirect URI in the
//    Spotify app settings — e.g. https://you.github.io/spicy-lyrics/ or
//    http://127.0.0.1:5173 for local dev. It must match REDIRECT_URI below.
// ---------------------------------------------------------------------------

export const CLIENT_ID: string =
  (import.meta as any).env?.VITE_SPOTIFY_CLIENT_ID ?? "PUT_YOUR_SPOTIFY_CLIENT_ID_HERE";

// The page redirects back to itself after Spotify login.
export const REDIRECT_URI: string =
  (import.meta as any).env?.VITE_SPOTIFY_REDIRECT_URI ??
  `${window.location.origin}${window.location.pathname}`;

// Scopes:
// - streaming + user-read-email/private: required by the Web Playback SDK
// - user-read-playback-state / modify / currently-playing: read & control
//   playback (also powers the iPad "mirror another device" mode)
export const SCOPES: string[] = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
];

// Lyrics API base. If the API doesn't send permissive CORS headers for your
// hosting origin, point this at a small CORS proxy you control via
// VITE_LYRICS_API (see README → "CORS").
export const LYRICS_API: string =
  (import.meta as any).env?.VITE_LYRICS_API ?? "https://api.spicylyrics.org";
export const CLIENT_VERSION = "web-standalone";

// The Web Playback SDK is unsupported in mobile browsers (iOS/iPadOS Safari,
// most mobile Chrome). We detect that to fall back to Spotify Connect mirror.
export const SDK_SUPPORTED: boolean = (() => {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  return !isIOS && !isAndroid;
})();
