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

The fix is the included **proxy** (`web/server/`), which injects the expected
headers server-side and adds permissive CORS. It is a plain Node process — one
container, no dependencies, no database — so it runs on any VPS or home server:

```bash
cd web/server
cp .env.example .env     # put your sp_dc cookie in it (see "Synced lyrics")
docker compose up -d     # listens on 127.0.0.1:8787
```

Then set `VITE_LYRICS_API` to the proxy's public URL (as a GitHub Actions
Variable, or in your local build env) and rebuild. The page will send its
requests through the proxy, which forwards them to `api.spicylyrics.org` with:

- `Origin: https://xpui.app.spotify.com`
- `Referer: https://xpui.app.spotify.com/`
- a Spotify-client `User-Agent`
- `SpicyLyrics-Version` (the `CLIENT_VERSION` var, `6.3.20` by default)

and passes your `SpicyLyrics-WebAuth` Bearer token straight through (never logged
or stored).

> Do not host it on Cloudflare Workers: the API's WAF refuses requests coming
> from there (see "If the API blocks the proxy"). That is why this runs on an
> ordinary machine.

> If `api.spicylyrics.org` happens to allow your origin directly, you can skip the
> proxy and leave `VITE_LYRICS_API` unset — but the proxy is the reliable path.

### One client, however many devices

The API's session model expects each client to open a session and keep it alive.
Left alone, every browser does that for itself: four devices means four sessions,
four ping loops and four identical lyric lookups for the same song — the exact
traffic shape that gets a client rate-limited.

The proxy collapses all of it into one upstream identity:

| From the browsers | Reaches `api.spicylyrics.org` |
|---|---|
| `createSession` / `refreshSession` / `ping` / `pingConfig`, per device | nothing — answered by the proxy, which owns **one** shared session |
| the shared session's keep-alive | one ping loop, on the API's own schedule, regardless of device count |
| 4 devices starting the same song at once | **1** lyric request (in-flight coalescing) |
| that song, ever again | **0** — served from the local cache for 7 days |
| nobody listening for 30 min | **0** — the shared session is dropped, not pinged forever |

One process is one hub, so "one session for every device" is simply what running
it gets you. The session, its keep-alive schedule and the lyric cache are all
persisted, so restarting the container costs nothing upstream.

Browsers still run their own session loop, but through the proxy it is local and
free: the proxy answers with a proxy-local token and a 15-minute ping interval,
and the page parks that timer entirely while it's in the background.

Check what is actually going out:

```
GET http://<your-proxy>/__spicy/stats
{
  "sessionOpen": true,
  "stats": { "clientOps": 47, "createSession": 1, "ping": 3, "lyricsUpstream": 6, ... }
}
```

`clientOps` is what the devices asked for; `ping` + `lyricsUpstream` is what was
forwarded. The gap is the point.

Logs are one JSON object per line on stdout (`docker compose logs -f`). Filter on
`evt`: `upstream` (a call that really left), `cache` (`hit` / `coalesced` /
`miss`), `session_op_local`, `session_opened` / `session_dropped`. Set
`LOG_LEVEL=debug` in `.env` to also see cache hits and per-device session ops.

Everything tunable is an environment variable (cache TTLs, the client ping
interval, the idle timeout, `LOG_LEVEL`, `CLIENT_VERSION`) — `.env.example` lists
them all. `npm test` inside `web/server/` runs offline tests that assert the
"4 devices → 1 request" behaviour, end to end and across a restart.

### If the API blocks the proxy

`api.spicylyrics.org` sits behind Cloudflare and its WAF can refuse traffic
outright — including, as of this writing, requests coming from Cloudflare
Workers, which is why this proxy runs on an ordinary machine instead. The symptom
is a Cloudflare "Sorry, you have been blocked" HTML page where an API response
should be, for *every* operation, so nothing loads and the shared session never
opens.

Two shapes of it, and the difference decides what to do:

| What comes back | `kind` | What it means |
|---|---|---|
| `Sorry, you have been blocked` | `cloudflare-block` | the address is on a deny rule |
| `Just a moment…` / `Verifying you are human` | `cloudflare-challenge` | the address is being challenged — typical for a datacenter/VPS IP |

A challenge cannot be solved server-side (that is the point of it), so the fix is
to leave from somewhere else: `PROXY_URL` (below) routes the proxy's own outbound
traffic through a SOCKS5/HTTP proxy on a different network path. Nothing else in
the setup needs to change.

The proxy names this rather than letting it look like a lyrics error:

- `/__spicy/stats` reports `upstreamBlocked: { count, lastAt, kind }` and
  `sessionOpen: false`.
- The logs carry `evt="upstream_blocked"` at `warn` level.
- The page shows "L'API Spicy Lyrics refuse les requêtes du proxy" instead of a
  generic failure, and the block page is never cached or handed to the JSON
  parser. Detection is on the *content type*: the API answers `/query` with JSON
  always, so any HTML body is something in front of it answering instead. (It
  used to match on the page's wording, which missed the challenge page entirely.)

To confirm it is the network path and not your setup, send the same request from
a different machine — if that returns 200 while the proxy gets 403, the request
shape is fine and the hosting location is what is being refused:

```bash
curl -s -X POST https://api.spicylyrics.org/query \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://xpui.app.spotify.com' \
  -H 'Referer: https://xpui.app.spotify.com/' \
  -H 'SpicyLyrics-Version: 6.3.20' -H 'X-mode: 2' \
  -d '{"queries":[{"operationId":"0","operation":"pingConfig","variables":{}}]}'
```

`/__spicy/tokencheck` returning `ok` at the same time confirms the `SP_DC`
cookie is not the problem.

The API's own response carries this notice: *"Access is granted solely for
personal, individual use through official Spicy Lyrics clients or their public
forks of official repositories."* Personal use through a fork is what this build
is; the sensible fixes are to move the proxy to a different machine or network
path (`PROXY_URL`, below) or to ask the Spicy Lyrics maintainers. Do not try to
defeat the block by rotating addresses or disguising the client.

## Running the proxy (`web/server/`)

Two files: `proxy.mjs` is the logic (CORS, the minted web-player token, the
shared session, coalescing) and `server.mjs` is the HTTP server plus the disk
behind it — the lyric cache (memory in front of disk, so the 7-day cache survives
a restart) and the hub's state in a JSON file. No dependencies at all: Node 20+
already provides `fetch`, `Request`/`Response` and `crypto.subtle`.

### Docker Compose (recommended)

```bash
cd web/server
cp .env.example .env     # SP_DC at minimum
docker compose up -d
docker compose logs -f   # one JSON line per event
```

The image is `node:22-alpine` plus three source files — nothing to install, so it
builds in seconds and idles around 60–80 MB. The compose service runs read-only
with all capabilities dropped, caps its own logs, and keeps the session and lyric
cache in a named volume so restarts and upgrades cost nothing upstream.

**No port is published on the host.** The proxy talks to the API as *your*
Spotify account, so it is not something to leave listening on a machine's
interfaces. Instead the container joins the reverse proxy's own Docker network —
Nginx Proxy Manager's `npm_default` by default — and is reached there by
container name:

| Nginx Proxy Manager → Proxy Hosts → Add | |
|---|---|
| Domain Names | `lyrics.example.com` |
| Forward Hostname / IP | `spicy-lyrics-proxy` |
| Forward Port | `8787` (or your `PORT`) |
| SSL | request a certificate — the page needs HTTPS (see below) |

If your reverse proxy's network is named differently, set `PROXY_NETWORK` in
`.env`. Docker names it after the directory the reverse proxy's compose file
lives in (`npm/` → `npm_default`), so check with `docker network ls`. The network
must already exist — it belongs to the reverse proxy's stack, not to this one.

**Changing the port** (say 8787 already belongs to another container on that
network): put `PORT=8987` in `.env` and `docker compose up -d`. That is the whole
change — the server, the Docker healthcheck and compose's `expose` all read it —
then set the same number as NPM's Forward Port. Since nothing is published on the
host, the port can only clash with another container on the reverse proxy's
network, never with something on the machine itself.

Not running a reverse proxy in Docker? Uncomment the `ports:` block in
`compose.yaml` to publish it on `127.0.0.1` instead.

Updating: `git pull && docker compose up -d --build`.

### Without Docker

```bash
cd web/server
SP_DC='<your sp_dc cookie>' node server.mjs      # listens on :8787
npm test                                          # offline end-to-end tests
```

`web/server/spicy-lyrics-proxy.service` is a hardened systemd unit for the same
thing; put `SP_DC` in a `systemctl edit` drop-in rather than in the unit itself.

### Configuration

All from the environment (and so from `.env` under compose): `SP_DC`, `PORT`
(8787), `STATE_DIR` (`/state` in the container, `./.state` otherwise),
`LOG_LEVEL`, `CLIENT_VERSION`, `LYRICS_CACHE_TTL`, `LYRICS_MISS_CACHE_TTL`,
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

In Docker, `127.0.0.1` is the *container*, not your host. To reach a tunnel
running on the host, add `extra_hosts: ["host.docker.internal:host-gateway"]` to
the service in `compose.yaml` and set
`PROXY_URL=socks5://host.docker.internal:1080`.

No dependency was added for this: `web/server/outbound.mjs` implements the
SOCKS5 (RFC 1928/1929) and CONNECT handshakes and hands the resulting socket to
Node's own HTTP client, so only the two handshakes are hand-written — everything
above them, TLS included, is Node's.

Then set `VITE_LYRICS_API` to the host's URL and rebuild the page.

> **Serve it over HTTPS.** If the page is on HTTPS (GitHub Pages) and the proxy
> is on plain `http://`, the browser blocks the request as mixed content and
> nothing loads. The reverse proxy in front is what terminates TLS — in Nginx
> Proxy Manager, request a certificate on the proxy host above; with
> [Caddy](https://caddyserver.com/) instead, two lines do it:
>
> ```
> lyrics.example.com {
>     reverse_proxy spicy-lyrics-proxy:8787
> }
> ```
>
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
3. Put it in `web/server/.env` as `SP_DC=...` (that file is git-ignored). It
   stays server-side: it never reaches the browser and is never logged.
   ```bash
   cd web/server
   cp .env.example .env
   $EDITOR .env
   docker compose up -d
   ```

`sp_dc` is long-lived (months) — treat it like a password. If lyrics go back to
text-only, the cookie has expired; repeat the steps.

### How the token is minted (TOTP) — and staying current

Spotify mints the web-player token via `/api/token`, guarded by a **TOTP** (a
time-based code, RFC 6238, from a per-version "secret cipher" + a version number
`totpVer`). The proxy implements exactly what the web player / librespot do
(TOTP verified against the RFC 6238 test vectors, key derived by XORing the
cipher bytes with `(i % 33) + 9`).

Spotify **rotates the cipher and bumps `totpVer`** to deter scraping, so the
proxy **auto-updates**: it fetches the community-maintained cipher list
([`xyloflake/spot-secrets-go`](https://github.com/xyloflake/spot-secrets-go))
and uses the highest version (falling back to a baked-in copy, then to any older
version that still works). No code change needed across most rotations.

Verify minting works (never exposes the token):

```
GET http://<your-proxy>/__spicy/tokencheck
→ { "ok": true, "totpVer": "61" }        # good
→ { "ok": false, "reason": "..." }        # cookie expired or secret rotated
```

Manual overrides (rarely needed), as environment variables: `TOTP_SECRET` (a
digit-string key), `TOTP_VER`, `SECRET_DICT_URL`, or `DISABLE_SECRET_FETCH=1`.

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
