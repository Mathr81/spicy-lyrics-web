# Spicy Lyrics — Web

A self-hostable **web version of the Spicy Lyrics fullscreen lyrics page** — the
beautiful synced, syllable-animated lyrics from the
[Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) Spicetify extension,
running in any browser instead of inside the Spotify desktop client. Open it on a
desktop, an iPad, an Android phone — anywhere a browser runs — and add it to your
home screen as an app.

![Lyrics preview](./previews/page.gif)

> This repo is a **fork of the Spicy Lyrics extension**, repurposed for the web.
> It **reuses the extension's real rendering engine** — the exact same syllable
> animator, springs/splines, virtualizer and CSS — and only swaps the
> `window.Spicetify` runtime for a browser-friendly Spotify adapter, so the
> lyrics look and animate identically to the extension.

---

## What it does

|                | How |
|----------------|-----|
| **Lyrics**     | `api.spicylyrics.org` — the same source as the extension |
| **Login**      | Spotify OAuth 2.0 **PKCE** (no client secret — safe for a static site) |
| **Playback / sync** | **Web Playback SDK** on desktop · **Spotify Connect mirror** on iPad/mobile |
| **UI**         | Cover-hover round controls, swap sides, compact mode, romanization, settings, Picture-in-Picture, fullscreen |
| **Install**    | Installable PWA (Add to Home Screen), offline-friendly lyric cache |

## Quick start

```bash
bun install
bun run web:dev        # local dev server → http://127.0.0.1:5173
bun run web:build      # static production build → web/dist/
bun run web:preview    # preview the production build
```

Then deploy the contents of `web/dist/` to any static host (GitHub Pages,
Netlify, Cloudflare Pages, your own server…).

**Full setup — Spotify app, synced-lyrics proxy, GitHub Pages auto-deploy — is in
[`web/README.md`](./web/README.md).** Read that before your first deploy; synced
(not just static) lyrics need the small Cloudflare Worker described there.

## Install as an app

- **Desktop (Chrome/Edge):** the install icon in the address bar, or the ⛶
  button for fullscreen. Picture-in-Picture pops the lyrics into a floating
  always-on-top window.
- **Android:** *Add to Home Screen* → launches true fullscreen.
- **iPad / iPhone:** *Share → Add to Home Screen*. A couple of iOS realities to
  know:
  - iOS **always** draws its status-bar clock and the home-indicator bar over a
    home-screen web app — there is **no web API to hide them**. The page already
    draws edge-to-edge behind them (`viewport-fit=cover` + a translucent status
    bar), so it's as close to fullscreen as a home-screen PWA can get.
  - For **true** fullscreen (status bar hidden too), open the site in **Safari**
    (a normal tab) on **iPad** and tap the **⛶** button — iPad Safari supports
    the Fullscreen API. iPhone Safari does not, so the ⛶ button is hidden there.

## Repository layout

This is one repo serving two things — the upstream extension it forks, and the
web wrapper that reuses it:

| Path | What it is |
|------|-----------|
| `src/` | The **upstream extension** source — the shared rendering engine. Treat as upstream; avoid editing directly (see updating below). |
| `web/` | The **web app** — everything specific to this project lives here. |
| `web/src/shim/` | Browser stand-ins for the Spicetify-coupled modules (`SpotifyPlayer`, `Platform`, `PageView`, `Fullscreen`, …). |
| `web/src/spotify/` | The Spotify adapter — OAuth PKCE, Web Playback SDK, Connect mirror. |
| `web/src/lyrics/` | Lyrics fetch, API session keep-alive, caching. |
| `web/proxy/` | The Cloudflare Worker that unlocks synced lyrics + edge-caches them. |
| `vite.config.ts` | Wires it together — aliases + a plugin that swaps the shimmed modules at build time. |

## Keeping up with upstream Spicy Lyrics

Because the web app reuses the extension's engine, you pull improvements to the
real lyrics rendering by **merging the upstream extension into this fork**. Step
by step — including what to do about the shims — is in **[`UPDATING.md`](./UPDATING.md)**.

## Credits & license

Built on top of **[Spicy Lyrics](https://github.com/spikerko/spicy-lyrics)** by
Spikerko — all of the lyrics rendering brilliance is theirs; this project only
puts it on the web. Itself inspired by
[Beautiful Lyrics](https://github.com/surfbryce/beautiful-lyrics).

See [`LICENSE`](./LICENSE). Lyrics are served by `api.spicylyrics.org` for
personal use through official clients and their forks — please use it as such.
