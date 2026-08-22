# Updating from upstream Spicy Lyrics

This project is a **fork** of the [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics)
extension. The web app in `web/` reuses the extension's rendering engine in
`src/`, so when the real extension ships an update, you get its improvements by
**merging upstream `src/` into this fork**.

Everything specific to the web version lives under `web/` (plus `vite.config.ts`
at the root), and upstream never touches those — so merges are usually clean, and
conflicts, when they happen, are almost always inside `src/`.

## One-time setup

Add the upstream repo as a git remote (only needed once per clone):

```bash
git remote add upstream https://github.com/spikerko/spicy-lyrics.git
```

Check it's there with `git remote -v` (you should see both `origin` — your fork —
and `upstream`).

## Each time you want to update

```bash
# 1. Get the latest upstream code
git fetch upstream

# 2. Start from a clean, up-to-date main on your fork
git checkout main
git pull origin main

# 3. Do the update on a branch (never straight on main)
git checkout -b update/upstream-sync

# 4. Merge the upstream default branch (it's usually "main")
git merge upstream/main
```

### If there are conflicts

They'll be in `src/` (the shared engine). For each conflicted file, **keep the
upstream version** unless the conflict is in a file you deliberately changed in
this fork — you generally have not touched `src/`, so:

```bash
# take upstream's version of a conflicted engine file
git checkout --theirs <path/in/src>
git add <path/in/src>
```

Then finish the merge: `git commit`.

> If a conflict lands in `web/` or `vite.config.ts`, that's *your* code — resolve
> it by hand, keeping your web-side intent.

## After merging — verify the shims still line up

The web build works by **swapping** a handful of Spicetify-coupled modules for
browser shims (see the `swapModules` plugin in `vite.config.ts`). If an upstream
update **renames, moves, or changes the exported shape** of a shimmed module, the
build will fail or misbehave until the shim is updated to match.

Shimmed modules live in `web/src/shim/` and are mapped in `vite.config.ts`:
`SpotifyPlayer`, `Platform`, `PageView`, `Fullscreen`, `CompactMode`,
`dynamicBackground`, `ApplyIsByCommunity`, `ProcessLyrics`.

So after the merge:

```bash
bun install          # in case upstream changed dependencies
bun run web:build    # must succeed
bun run web:preview  # smoke-test the lyrics render, sync, controls
```

- **Build error about a missing/renamed module?** Upstream moved something a
  shim or `vite.config.ts` alias points at — update the path there.
- **Build OK but something's broken at runtime** (e.g. lyrics don't sync, cover
  controls misbehave)? An interface a shim implements probably changed — open the
  matching file in `web/src/shim/` and realign it with the new upstream module.
- **New API version?** If upstream bumps the API/client version (see
  `project/config.ts` → `ProjectVersion`, currently `6.2.3`), match it in
  `web/src/config.ts` (`CLIENT_VERSION`) and, if the lyrics API changed its
  session/query protocol, in `web/src/lyrics/` and `web/proxy/worker.js`.

## Finish

```bash
git push -u origin update/upstream-sync
```

Open a PR from `update/upstream-sync` into your `main`, let the GitHub Pages build
run, confirm the deployed site still works, then merge. If you changed
`web/proxy/worker.js`, redeploy the Worker too (`cd web/proxy && npx wrangler deploy`).
