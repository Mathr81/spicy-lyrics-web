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
| Lyrics         | the official Spicy Lyrics API (`GET /v1/lyrics/{trackId}`), through the bundled proxy |
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
VITE_LYRICS_API=https://lyrics.example.com                           # your proxy, see below
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

## Lyrics API access — the key and the proxy

Lyrics come from the official Spicy Lyrics developer API:

```http
GET https://api.spicylyrics.org/v1/lyrics/{trackId}
Authorization: Bearer sl_sk_…
```

It answers `{ "Body": <lyrics>, "Status": 200, "Type": "object" }`, where the
body is the single best sync for the track (`Type` is `Syllable`, `Line` or
`Static`) in the same shape the extension's engine already renders. Errors use
the same envelope with `Body.error` (`lyrics_not_found`, `rate_limited`, …).

The API needs a key, and a **secret key (`sl_sk_…`) must never reach a
browser** — anything in the page's bundle is public. The API also sends no CORS
headers for a secret key, so the page could not use one anyway. So the page
talks to the included **proxy** (`web/server/`), which holds the key
server-side:

```bash
cd web/server
cp .env.example .env     # put SPICY_API_KEY=sl_sk_… in it
docker compose up -d     # see "Running the proxy" below
```

Then set `VITE_LYRICS_API` to the proxy's public URL (as a GitHub Actions
Variable, or in your local build env) and rebuild. The page asks
`GET {VITE_LYRICS_API}/v1/lyrics/{trackId}` — the API's own path — and the proxy
forwards it with the key and adds CORS. The key is never logged or returned.

> The build **refuses** to run if any `VITE_*` variable holds an `sl_sk_` key,
> since it would be published in the bundle.

> **Without a proxy:** create a *publishable* key (`sl_pk_…`) with your site's
> origin on its allowlist, set it as `VITE_SPICY_PUBLISHABLE_KEY`, and leave
> `VITE_LYRICS_API` unset (it defaults to `https://api.spicylyrics.org`). The
> page then sends that key itself. You lose the shared cache below, and a
> publishable key also has a per-viewer IP limit.

### One request per song, however many devices

The key has a request window per application (the `RateLimit-*` headers — 60
per window at the time of writing), shared by every device using the proxy. The
proxy keeps traffic well under it:

| From the browsers | Reaches `api.spicylyrics.org` |
|---|---|
| 4 devices starting the same song at once | **1** request (in-flight coalescing) |
| that song, ever again | **0** — served from the proxy's cache for 7 days |
| a song with no lyrics (`404`) | **1**, then **0** for an hour |
| anything, once the window is exhausted (`429 rate_limited`) | **0** until it resets — the proxy answers `429` itself, cache hits keep working |

The page adds its own layer on top: every sync it has loaded is kept in
`localStorage`, so a song you have already seen on a device never leaves it.

Check what is actually going out (the key is never shown):

```
GET http://<your-proxy>/__spicy/stats
{
  "keyConfigured": true,
  "keyKind": "secret",
  "rateLimit": { "limit": 60, "remaining": 57, "resetsInSeconds": 21, "coolingDownForSeconds": 0 },
  "upstreamBlocked": null,
  "stats": { "requests": 47, "cacheHits": 38, "coalesced": 3, "upstream": 6, ... }
}
```

`requests` is what the devices asked for; `upstream` is what was forwarded. The
gap is the point.

Logs are one JSON object per line on stdout (`docker compose logs -f`). Filter on
`evt`: `upstream` (a call that really left, with the remaining window), `cache`
(`hit` / `coalesced` / `miss` / `cooldown`), `rate_limited`, `upstream_failed`.
Set `LOG_LEVEL=debug` in `.env` to also see cache hits.

`npm test` inside `web/server/` runs offline tests for all of this, end to end
and across a restart.

### Credits for community syncs

When a sync comes from the community (`source: "spicy_lyrics"`), the API includes
`UploadAttribution` and asks clients to credit the uploader (and the maker, when
there is one). The page shows it under the lyrics — "Made by @…", linking to the
contributor's profile — alongside "Provided by: …" for every source.

### If the API blocks the proxy

`api.spicylyrics.org` sits behind Cloudflare. If its WAF ever refuses the
proxy's network path, the answer is an HTML page ("Sorry, you have been blocked"
or a "Just a moment…" challenge) instead of JSON. The proxy detects that on the
content type, never caches it, answers `502` with `X-Spicy-Upstream: blocked`,
reports it under `upstreamBlocked` in `/__spicy/stats` and logs
`evt="upstream_blocked"`; the page says "L'API Spicy Lyrics refuse les requêtes
du proxy" instead of a generic failure. `PROXY_URL` (below) routes the proxy's
outbound traffic through a different network path.

## Running the proxy (`web/server/`)

Two files: `proxy.mjs` is the logic (CORS, the API key, coalescing, the
rate-limit cooldown) and `server.mjs` is the HTTP server plus the disk behind
it — the lyric cache, memory in front of disk, so the 7-day cache survives a
restart. No dependencies at all: Node 20+ already provides `fetch` and
`Request`/`Response`.

### Docker Compose (recommended)

```bash
cd web/server
cp .env.example .env     # SPICY_API_KEY at minimum
docker compose up -d
docker compose logs -f   # one JSON line per event
```

The image is `node:22-alpine` plus three source files — nothing to install, so it
builds in seconds and idles around 60–80 MB. The compose service runs read-only
with all capabilities dropped, caps its own logs, and keeps the lyric cache in a
named volume so restarts and upgrades cost nothing upstream.

**No port is published on the host.** The proxy spends *your* API key's request
window, so it is not something to leave listening on a machine's interfaces. Instead the container joins the reverse proxy's own Docker network —
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
SPICY_API_KEY='sl_sk_…' node server.mjs      # listens on :8787
npm test                                      # offline end-to-end tests
```

`web/server/spicy-lyrics-proxy.service` is a hardened systemd unit for the same
thing; put `SPICY_API_KEY` in a `systemctl edit` drop-in rather than in the unit
itself.

### Configuration

All from the environment (and so from `.env` under compose): `SPICY_API_KEY`
(required), `PORT` (8787), `STATE_DIR` (`/state` in the container, `./.state`
otherwise), `LOG_LEVEL`, `LYRICS_CACHE_TTL` (604800 s), `LYRICS_MISS_CACHE_TTL`
(3600 s), and `API_ORIGIN` if you ever need to point it at a mirror.

### Sending the proxy's own traffic through another proxy

`PROXY_URL` routes everything this process sends to the lyrics API through a
SOCKS5 or HTTP CONNECT proxy:

```bash
PROXY_URL=socks5://127.0.0.1:1080 SPICY_API_KEY='sl_sk_…' node server.mjs
PROXY_URL=socks5://user:pass@127.0.0.1:1080 …     # with credentials
PROXY_URL=http://127.0.0.1:3128 …                 # an HTTP CONNECT proxy
PROXY_URL=127.0.0.1:1080 …                        # bare host:port means socks5
```

`socks5://` and `socks5h://` behave identically: the hostname is always resolved
*by the proxy*, never locally, which is the only sensible behaviour for a tunnel
meant to change your exit path. `ALL_PROXY` works too.

> `HTTPS_PROXY` / `HTTP_PROXY` are deliberately **not** picked up. They are
> commonly set on a machine for unrelated reasons, and inheriting them silently
> would reroute this process's traffic — API key included — somewhere you
> never chose. If that is what you want, say it: `PROXY_URL="$HTTPS_PROXY"`.

The startup log always states where outbound traffic goes, and a proxy that
cannot be reached fails the request rather than quietly falling back to a direct
connection.

### Reaching the tunnel from inside the container

`127.0.0.1` in `PROXY_URL` is the *container*, not your host — so a tunnel
running on the machine needs an address the container can actually route to.

**If the tunnel is itself a container**, this is easy and is the setup to prefer:
put it on the same network as the proxy and use its container name.

```bash
PROXY_URL=socks5://my-tunnel:1080
```

**If the tunnel runs on the host**, use the gateway address of *this container's*
network, and make sure the tunnel listens on it — one bound to `127.0.0.1` is
unreachable from every container, whatever address you point at it:

```bash
docker network inspect npm_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
# -> 172.18.0.1
sudo ss -lntp | grep 1080     # must not be 127.0.0.1:1080 only
```

```bash
PROXY_URL=socks5://172.18.0.1:1080
```

With an SSH dynamic forward, that means giving `-D` an explicit bind address —
`ssh -D 1080` listens on `127.0.0.1` only:

```bash
ssh -D 172.18.0.1:1080 -N user@host      # not: ssh -D 1080
# if your client refuses the non-loopback bind: -o GatewayPorts=yes
```

Check it from inside the container before blaming the proxy — this separates
"cannot reach the tunnel" from "the tunnel refused the handshake":

```bash
docker exec spicy-lyrics-proxy node -e "const s=require('net').connect(1080,'172.18.0.1');s.setTimeout(3000,()=>{console.log('NOT reachable: timeout');process.exit(1)});s.on('connect',()=>{console.log('reachable');process.exit(0)});s.on('error',e=>{console.log('NOT reachable:',e.code);process.exit(1)})"
```

`reachable` → good. `timeout` → no route (wrong gateway, or the tunnel is
loopback-bound). `ECONNREFUSED` → the address is right but nothing is listening
on that port.

> **Two things to know before settling on the gateway address.** It is reachable
> by *every* container on that network, so the tunnel is shared with your whole
> reverse-proxy stack — not exposed outside the host, but not private either. And
> Docker assigns the subnet when it creates the network, so recreating it can
> move `172.18.0.1` and silently break `PROXY_URL`. Running the tunnel as a
> container on the network avoids both: a container name never changes.

> `extra_hosts: ["host.docker.internal:host-gateway"]` does **not** work here,
> though it is the advice you will find everywhere. It resolves to the *default*
> bridge's gateway (`172.17.0.1`), and a container attached to a user-defined
> network — which is exactly what joining the reverse proxy's network means —
> has no route to it. The symptom is `EHOSTUNREACH 172.17.0.1:<port>` in the
> logs.

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

## How it works (architecture)

`vite.config.ts` reuses the engine from `../src` and redirects a small set of
Spicetify-coupled modules to shims in `web/src/shim/`:

| Original (`src/…`) | Shim | Why |
|---|---|---|
| `components/Global/SpotifyPlayer.ts` | `SpotifyPlayer.ts` | position clock + track state from the adapter |
| `components/Global/Platform.ts` | `Platform.ts` | Spotify access token for the engine |
| `components/Pages/PageView.ts` | `PageView.ts` | live `PageContainer` reference |
| `components/Utils/Fullscreen.ts` | `Fullscreen.ts` | native Fullscreen API |
| `components/Utils/CompactMode.ts` | `CompactMode.ts` | layout stub |
| `components/DynamicBG/dynamicBackground.ts` | `dynamicBackground.ts` | Kawarp cover warp (no GraphQL colors / artist header) |
| `utils/Lyrics/ProcessLyrics.ts` | `ProcessLyrics.ts` | drop on-device romanization CDN loads; use API transliterations |
| `utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx` | `ApplyIsByCommunity.ts` | community credit with plain links instead of Spicetify tooltips |

Everything else — the animator, the Applyer, the virtualizer, the scroll engine,
the CSS — is the **unmodified extension code**.
