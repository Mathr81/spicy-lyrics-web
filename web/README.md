# Spicy Lyrics — Standalone Web

A self-hostable web version of the Spicy Lyrics **fullscreen lyrics page**, built
to run anywhere a browser does (desktop, iPad, …) instead of inside the Spotify
desktop client.

It **reuses the real rendering engine** from the extension — the exact same
syllable animator, springs/splines, virtualizer and CSS — and only swaps the
`window.Spicetify` runtime for a browser-friendly Spotify adapter. So the lyrics
look and animate identically to the extension.

|                | Source |
|----------------|--------|
| Lyrics         | `api.spicylyrics.org` (same as the extension) |
| Auth           | Spotify OAuth 2.0 **PKCE** (no secret — safe for a static site) |
| Playback/sync  | **Web Playback SDK** on desktop · **Spotify Connect mirror** on iPad |

## 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and **Create app**.
2. Copy the **Client ID**.
3. In the app settings, add your site URL as a **Redirect URI** — exactly, with
   no trailing slash, e.g.
   - `http://127.0.0.1:5173` for local dev, and/or
   - `https://yourname.github.io/spicy-lyrics/` for your hosted copy.

> The Web Playback SDK (in-tab audio) requires **Spotify Premium**. Free accounts
> can still use the **Connect mirror** mode (see below).

## 2. Configure

Either edit `web/src/config.ts` (set `CLIENT_ID`), or provide build-time env vars:

```bash
VITE_SPOTIFY_CLIENT_ID=xxxxxxxx
VITE_SPOTIFY_REDIRECT_URI=https://yourname.github.io/spicy-lyrics/   # optional, defaults to the page's own URL
VITE_LYRICS_API=https://api.spicylyrics.org                          # optional, see CORS below
```

## 3. Run / build

From the repo root:

```bash
bun install
bun run web:dev        # local dev server (http://127.0.0.1:5173)
bun run web:build      # static production build -> web/dist/
bun run web:preview    # preview the production build
```

Deploy the contents of `web/dist/` to any static host (GitHub Pages, Netlify,
Cloudflare Pages, an S3 bucket, your own server…). The build uses relative asset
paths, so it works from a sub-path too.

## Playback modes

The page picks a mode automatically:

- **Desktop** → **Web Playback SDK**: the page becomes its own Spotify device and
  plays audio in the tab. Pick a track from the search box and it plays + syncs.
- **iPad / iOS / most mobile** → **Spotify Connect mirror**: Spotify's SDK is not
  supported in mobile Safari, so instead the page *mirrors* whatever is playing
  on another device (your phone, desktop app, …) by polling `/me/player`. Start
  playback on that device and the lyrics follow in real time.

The status line under the top bar tells you which mode is active.

## Auto-deploy (GitHub Pages)

`.github/workflows/deploy-web.yml` builds `web/` and publishes `web/dist/` to
GitHub Pages on every push to `main`. One-time setup:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables**, add:
   - `VITE_SPOTIFY_CLIENT_ID` — your Spotify Client ID
   - `VITE_SPOTIFY_REDIRECT_URI` — your Pages URL, e.g.
     `https://<user>.github.io/<repo>/` (**with** the trailing slash)
   - `VITE_LYRICS_API` — (optional) your proxy URL, see below
3. Add that same redirect URI in your Spotify app settings.

Then push to `main` (or run the workflow manually) and it deploys itself.

## Demo mode

Append `?demo` to the URL to preview the animated lyrics with a built-in sample —
no Spotify login required. Handy for checking your deployment.

## API access — CORS & required headers (the proxy)

The lyrics API is built for the Spotify desktop client and expects request
headers a browser **cannot** set from a web page — `Origin`, `Referer` and
`User-Agent` are "forbidden headers" the browser controls itself. It may also not
send CORS headers for your hosting origin. So a direct browser call can be
rejected.

The fix is the included **Cloudflare Worker proxy** (`web/proxy/`), which injects
the expected headers server-side and adds permissive CORS:

```bash
cd web/proxy
npm install             # isolated: uses web/proxy/package.json, not the repo root
npx wrangler login      # first time only — opens the browser
npx wrangler secret put SP_DC   # (recommended) see "Synced lyrics" below
npx wrangler deploy     # prints https://spicy-lyrics-proxy.<you>.workers.dev
```

> Run these **inside `web/proxy/`** (it has its own `package.json`). Running
> wrangler from the repo root fails with `npm error EOVERRIDE` because the root
> `package.json` is a bun project with an `overrides` field npm rejects.
> No local install at all? Use the Cloudflare dashboard instead: Workers & Pages
> → Create Worker → paste `web/proxy/worker.js` → Deploy.

Then set `VITE_LYRICS_API` to that Worker URL (as a GitHub Actions Variable, or
in your local build env) and rebuild. The page will send its requests through the
Worker, which forwards them to `api.spicylyrics.org` with:

- `Origin: https://xpui.app.spotify.com`
- `Referer: https://xpui.app.spotify.com/`
- a Spotify-client `User-Agent`
- `SpicyLyrics-Version: 6.2.3`

and passes your `SpicyLyrics-WebAuth` Bearer token straight through (never logged
or stored). Any equivalent serverless function (Vercel/Netlify) works too — just
mirror `web/proxy/worker.js`.

> If `api.spicylyrics.org` happens to allow your origin directly, you can skip the
> proxy and leave `VITE_LYRICS_API` unset — but the proxy is the reliable path.

## Synced lyrics (the `SP_DC` secret)

Spotify's **synced** (word/line-timed) lyrics come from an internal endpoint that
only accepts Spotify's **web-player client token**. The extension has one (the
desktop client mints it); a third-party OAuth app token — which is all a website
can obtain — is **not** accepted there, so without extra setup the API can only
return plain **unsynced text**.

To get synced lyrics, the proxy mints a web-player token from your Spotify
account cookie `sp_dc`, server-side:

1. Log in to <https://open.spotify.com> in your browser.
2. DevTools → **Application → Cookies → https://open.spotify.com** → copy the
   value of the **`sp_dc`** cookie (a long string).
3. Store it as a Worker secret (it never reaches the browser, never gets logged):
   ```bash
   cd web/proxy
   npx wrangler secret put SP_DC   # paste the value when prompted
   npx wrangler deploy
   ```

`sp_dc` is long-lived (months) — treat it like a password. If lyrics go back to
text-only, the cookie has expired; repeat the steps.

> Heads-up: this uses Spotify's unofficial `get_access_token` endpoint. Spotify
> occasionally tightens it (anti-scraping/TOTP); if a valid cookie stops
> minting a token, the endpoint call in `web/proxy/worker.js` may need updating.

## How it works (architecture)

`vite.config.ts` reuses the engine from `../src` and redirects a small set of
Spicetify-coupled modules to shims in `web/src/shim/`:

| Original (`src/…`) | Shim | Why |
|---|---|---|
| `components/Global/SpotifyPlayer.ts` | `SpotifyPlayer.ts` | position clock + track state from the adapter |
| `components/Global/Platform.ts` | `Platform.ts` | access token for the lyrics API |
| `components/Pages/PageView.ts` | `PageView.ts` | live `PageContainer` reference |
| `components/Utils/Fullscreen.ts` | `Fullscreen.ts` | native Fullscreen API |
| `components/Utils/CompactMode.ts` | `CompactMode.ts` | layout stub |
| `components/DynamicBG/dynamicBackground.ts` | `dynamicBackground.ts` | Kawarp cover warp (no GraphQL colors / artist header) |
| `utils/Lyrics/ProcessLyrics.ts` | `ProcessLyrics.ts` | drop on-device romanization CDN loads; use API transliterations |
| `utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx` | `ApplyIsByCommunity.ts` | drop Spicetify-styled badge |

Everything else — the animator, the Applyer, the virtualizer, the scroll engine,
the CSS — is the **unmodified extension code**.
