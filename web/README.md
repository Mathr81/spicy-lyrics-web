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

## Installing on iPad / iPhone (PWA)

Safari → Share → **Add to Home Screen**. The installed app runs edge-to-edge:
`apple-mobile-web-app-status-bar-style: black-translucent` plus
`viewport-fit=cover` put the lyrics under the status bar instead of below it.

That combination has a well-known iOS side effect: the web view is drawn from the
physical top of the screen, but the *layout viewport* keeps the height it would
have had underneath the status bar. The document ends up shifted up, and the
strip it no longer covers at the bottom shows the manifest `background_color` —
the black bar. `web/src/viewport.ts` measures that deficit at runtime
(`screen height − innerHeight`, which in standalone mode is exactly the missing
strip) and `styles.css` grows the fixed page host by it, so the page reaches the
real bottom edge again. Scoped to installed iOS/iPadOS apps; nothing changes in a
Safari tab or on any other platform.

### Keeping the screen on

The page holds a **Screen Wake Lock** while something is playing, so the iPad
doesn't dim and lock mid-song — it has no `<video>` of its own, and in Connect
mirror mode the audio is coming out of a different device entirely, so iOS would
otherwise treat it as an idle tab.

The lock is re-acquired on `visibilitychange` (the system drops it whenever the
document is hidden and never restores it), and released as soon as playback
pauses. Settings → **Garder l'écran allumé** turns it off; the row only appears
where the API exists (Safari 16.4+ / iOS 16.4+, current Chromium).

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
- `SpicyLyrics-Version` (the `CLIENT_VERSION` var, `6.3.12` by default)

and passes your `SpicyLyrics-WebAuth` Bearer token straight through (never logged
or stored). Any equivalent serverless function (Vercel/Netlify) works too — just
mirror `web/proxy/worker.js`.

> If `api.spicylyrics.org` happens to allow your origin directly, you can skip the
> proxy and leave `VITE_LYRICS_API` unset — but the proxy is the reliable path.

### One client, however many devices

The API's session model expects each client to open a session and keep it alive.
Left alone, every browser does that for itself: four devices means four sessions,
four ping loops and four identical lyric lookups for the same song — the exact
traffic shape that gets a client rate-limited.

The Worker collapses all of it into one upstream identity:

| From the browsers | Reaches `api.spicylyrics.org` |
|---|---|
| `createSession` / `refreshSession` / `ping` / `pingConfig`, per device | nothing — answered by the Worker, which owns **one** shared session |
| the shared session's keep-alive | one ping loop, on the API's own schedule, regardless of device count |
| 4 devices starting the same song at once | **1** lyric request (in-flight coalescing) |
| that song, ever again | **0** — served from the edge cache for 7 days |
| nobody listening for 30 min | **0** — the shared session is dropped, not pinged forever |

The shared session lives in a Durable Object, so "one" holds across colos and
isolates rather than per-isolate. Without a Durable Object binding (a
paste-into-the-dashboard deploy) the Worker falls back to per-isolate sharing on
its own — same behaviour, weaker guarantee.

Browsers still run their own session loop, but through the proxy it is local and
free: the Worker answers with a proxy-local token and a 15-minute ping interval,
and the page parks that timer entirely while it's in the background.

Check what is actually going out:

```
GET https://<your-worker>.workers.dev/__spicy/stats
{
  "mode": "durable-object",
  "sessionOpen": true,
  "stats": { "clientOps": 47, "createSession": 1, "ping": 3, "lyricsUpstream": 6, ... }
}
```

`clientOps` is what the devices asked for; `ping` + `lyricsUpstream` is what was
forwarded. The gap is the point.

Logs are on (`[observability]` in `wrangler.toml`) — dashboard → Workers →
`spicy-lyrics-proxy` → Logs, or `npm run tail`. Filter on `evt`: `upstream` (a
call that really left), `cache` (`hit` / `coalesced` / `miss`),
`session_op_local`, `session_opened` / `session_dropped`. Set `LOG_LEVEL` to
`debug` in `wrangler.toml` to also see cache hits and per-device session ops.

Everything tunable lives in `[vars]` in `web/proxy/wrangler.toml` (cache TTLs,
the client ping interval, the idle timeout, `LOG_LEVEL`, `CLIENT_VERSION`) — no
code change to adjust any of it. `npm test` inside `web/proxy/` runs an offline
smoke test that asserts the "4 devices → 1 request" behaviour.

### If the API blocks the proxy

`api.spicylyrics.org` sits behind Cloudflare and its WAF can refuse traffic
outright — including, as of this writing, requests coming from Cloudflare
Workers. The symptom is a Cloudflare "Sorry, you have been blocked" HTML page
where an API response should be, for *every* operation, so nothing loads and the
shared session never opens.

The proxy names this rather than letting it look like a lyrics error:

- `/__spicy/stats` reports `upstreamBlocked: { count, lastAt }` and
  `sessionOpen: false`.
- The logs carry `evt="upstream_blocked"` at `warn` level.
- The page shows "L'API Spicy Lyrics refuse les requêtes du proxy" instead of a
  generic failure, and the block page is never cached or handed to the JSON
  parser.

To confirm it is the network path and not your setup, send the same request from
an ordinary machine — if that returns 200 and the Worker gets 403, the request
shape is fine and the hosting location is what is being refused:

```bash
curl -s -X POST https://api.spicylyrics.org/query \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://xpui.app.spotify.com' \
  -H 'Referer: https://xpui.app.spotify.com/' \
  -H 'SpicyLyrics-Version: 6.3.12' -H 'X-mode: 2' \
  -d '{"queries":[{"operationId":"0","operation":"pingConfig","variables":{}}]}'
```

`/__spicy/tokencheck` returning `ok` at the same time confirms the `SP_DC`
cookie is not the problem.

The API's own response carries this notice: *"Access is granted solely for
personal, individual use through official Spicy Lyrics clients or their public
forks of official repositories."* Personal use through a fork is what this build
is; the sensible fixes are to run the proxy from an ordinary machine (see below)
or to ask the Spicy Lyrics maintainers. Do not try to defeat the block by
rotating addresses or disguising the client.

## Running the proxy outside Cloudflare (`web/server/`)

`web/server/server.mjs` runs **the same `web/proxy/worker.js`**, unmodified, on
plain Node — on a VPS, a home server or in a container. It is not a second
implementation: Node 20 already provides `fetch`/`Request`/`Response`/
`crypto.subtle`, so the host only supplies the two things Workers adds — a
`caches.default` (memory + disk, so the 7-day lyric cache survives a restart) and
a Durable Object runtime (one process is one instance, with storage in a JSON
file and the keep-alive alarm on a timer). The shared session, the coalescing and
the TOTP token minting therefore cannot drift between the two hosts.

```bash
cd web/server
SP_DC='<your sp_dc cookie>' node server.mjs      # listens on :8787
npm test                                          # offline end-to-end tests
```

### Docker

`docker-compose.yml` is the easy path — it sets the build context, the state
volume and the host-gateway alias for you:

```bash
cd web/server
cp .env.example .env      # put your SP_DC in it (.env is gitignored)
docker compose up -d
docker compose logs -f    # the first lines say the port, and where outbound traffic goes
```

**Changing the port:** set `HOST_PORT` in `.env`, or inline:

```bash
HOST_PORT=9000 docker compose up -d
```

Only the host side moves — the container keeps listening on 8787, so the
healthcheck and the image are unaffected by whatever you publish on. Every other
setting is an entry in `.env` too (`PROXY_URL`, `LOG_LEVEL`, the cache TTLs…).

Useful afterwards:

```bash
docker compose ps                      # health: starting → healthy
docker compose restart                 # keeps the cache and the shared session
docker compose down                    # stop; the state volume survives
docker compose down -v                 # stop and wipe the cache/session too
docker compose up -d --build           # rebuild after pulling changes
curl localhost:${HOST_PORT:-8787}/__spicy/stats
```

By hand instead, **from the repo root** (the Dockerfile's `COPY` paths are
repo-relative, so the build context has to be the repository, not `web/server/`):

```bash
docker build -f web/server/Dockerfile -t spicy-lyrics-proxy .
docker run -d --name spicy-lyrics-proxy -p 8787:8787 \
  -e SP_DC='<your sp_dc cookie>' -v spicy-proxy-state:/state \
  --restart unless-stopped spicy-lyrics-proxy
```

### systemd

`web/server/spicy-lyrics-proxy.service` is a hardened unit file; put `SP_DC` in a
`systemctl edit` drop-in rather than in the unit itself.

Configuration is the same names as the Worker's `[vars]`, read from the
environment: `SP_DC`, `PORT` (8787), `STATE_DIR` (`./.state`), `LOG_LEVEL`,
`CLIENT_VERSION`, `LYRICS_CACHE_TTL`, `LYRICS_MISS_CACHE_TTL`,
`CLIENT_PING_INTERVAL_MS`, `CLIENT_SESSION_TTL_S`, `SESSION_IDLE_MS`, and
`API_ORIGIN` if you ever need to point it at a mirror.

### Sending the proxy's own traffic through another proxy

`PROXY_URL` routes everything this process sends — the lyrics API *and*
Spotify's token endpoints — through a SOCKS5 or HTTP CONNECT proxy:

```bash
PROXY_URL=socks5://127.0.0.1:1080 SP_DC='…' node server.mjs
PROXY_URL=socks5://user:pass@127.0.0.1:1080 …     # with credentials
PROXY_URL=http://127.0.0.1:3128 …                 # an HTTP CONNECT proxy
PROXY_URL=127.0.0.1:1080 …                        # bare host:port means socks5
```

`socks5://` and `socks5h://` behave identically: the hostname is always resolved
*by the proxy*, never locally, which is the only sensible behaviour for a tunnel
meant to change your exit path. `ALL_PROXY` works too.

> `HTTPS_PROXY` / `HTTP_PROXY` are deliberately **not** picked up. They are
> commonly set on a machine for unrelated reasons, and inheriting them silently
> would reroute this process's traffic — Spotify tokens included — somewhere you
> never chose. If that is what you want, say it: `PROXY_URL="$HTTPS_PROXY"`.

The startup log always states where outbound traffic goes, and a proxy that
cannot be reached fails the request rather than quietly falling back to a direct
connection.

In Docker, `127.0.0.1` is the *container*, not your host. Use `--network host`,
or `--add-host=host.docker.internal:host-gateway` with
`PROXY_URL=socks5://host.docker.internal:1080`.

No dependency was added for this: `web/server/outbound.mjs` implements the
SOCKS5 (RFC 1928/1929) and CONNECT handshakes and hands the resulting socket to
Node's own HTTP client, so only the two handshakes are hand-written — everything
above them, TLS included, is Node's.

Then set `VITE_LYRICS_API` to the host's URL and rebuild the page.

> **Serve it over HTTPS.** If the page is on HTTPS (GitHub Pages) and the proxy
> is on plain `http://`, the browser blocks the request as mixed content and
> nothing loads. Put [Caddy](https://caddyserver.com/) (automatic certificates)
> or a Cloudflare Tunnel in front. A tunnel is a good fit for a home server with
> no public address — it only handles traffic *in*; requests to the lyrics API
> still leave from your own connection, which is the point of moving off Workers.
> The Screen Wake Lock also needs a secure context, so HTTPS is required for the
> iPad to stay awake.

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

### How the token is minted (TOTP) — and staying current

Spotify mints the web-player token via `/api/token`, guarded by a **TOTP** (a
time-based code, RFC 6238, from a per-version "secret cipher" + a version number
`totpVer`). The Worker implements exactly what the web player / librespot do
(TOTP verified against the RFC 6238 test vectors, key derived by XORing the
cipher bytes with `(i % 33) + 9`).

Spotify **rotates the cipher and bumps `totpVer`** to deter scraping, so the
Worker **auto-updates**: it fetches the community-maintained cipher list
([`xyloflake/spot-secrets-go`](https://github.com/xyloflake/spot-secrets-go))
and uses the highest version (falling back to a baked-in copy, then to any older
version that still works). No code change needed across most rotations.

Verify minting works (never exposes the token):

```
GET https://<your-worker>.workers.dev/__spicy/tokencheck
→ { "ok": true, "totpVer": "61" }        # good
→ { "ok": false, "reason": "..." }        # cookie expired or secret rotated
```

Manual overrides (rarely needed) via Worker env: `TOTP_SECRET` (a digit-string
key), `TOTP_VER`, `SECRET_DICT_URL`, or `DISABLE_SECRET_FETCH=1`.

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
