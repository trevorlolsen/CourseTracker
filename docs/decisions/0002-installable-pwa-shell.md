# ADR 0002 — Installable PWA shell, hand-authored

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** §15 of `docs/superpowers/specs/2026-09-02-youtube-course-tracker-design.md`,
  which lists an installable PWA shell as deferred until after v1

## Context

CourseTracker is described in its own README as mobile-friendly, but there was
no way to install it. Chrome on Android never offers installation without a
service worker, and iOS Add-to-Home-Screen produced a generic icon and a
browser-chrome shell, because the only icon in the repo was an inline data-URI
SVG in `index.html`.

The design doc deferred this past v1. Building it now is a departure, and ADR
0001 exists precisely because an earlier departure shipped without a record.

Two things made the change worth pulling forward:

- **Storage durability.** Data lives only in IndexedDB and there is no server.
  Safari's tracking prevention clears script-writable storage for sites left
  unused for about a week, which for this app means total loss. Installed
  home-screen apps are exempt. Installing is the most effective protection a
  Safari user has, and it was unavailable.
- **The mobile groundwork was already done.** `viewport-fit=cover`, a
  `theme-color`, 44px touch targets, safe-area insets on toasts, and a dark
  `color-scheme` were all in place. What was missing was a manifest, icons, and
  a worker.

## Decision

Hand-author the manifest, service worker, and icon generator into the repo. No
Workbox, no `vite-plugin-pwa`, no new dependencies, and no build step —
consistent with ADR 0001.

- `site/manifest.webmanifest` with relative `start_url` and `scope`.
- `site/sw.js`: a classic script that precaches the app shell, serves
  navigations network-first and subresources cache-first, and passes every
  cross-origin request through untouched.
- `scripts/generate-icons.mjs`: a PNG encoder over `node:zlib` plus a
  supersampled rasteriser for the existing play mark. Icons are generated and
  committed, because there is nothing to generate them at deploy time.
- An "Install on this device" section in Settings, and one offline strip in the
  app shell.

## Rationale

**Why the manifest omits `id`.** `start_url` and `scope` resolve against the
manifest URL, which is what makes them work under the `/CourseTracker/` Pages
subpath. `id` does not: it resolves against the *origin*. Writing `"id": "./"`
would have claimed `https://<user>.github.io/` — the shared account root, which
another project could equally claim. Hardcoding `"/CourseTracker/"` would be
wrong under `npm run dev`. Omitted, `id` defaults to the processed `start_url`,
which is correct in both places. `tests/pwa.test.mjs` asserts its absence and
carries this reasoning, because a `.webmanifest` cannot hold a comment.

**Why `SHELL_REVISION` instead of a hand-bumped version.** A browser only
reinstalls a worker when the worker script changes byte-wise. With cache-first
serving, a hand-bumped `v1`, and no content-hashed filenames, editing a module
and forgetting to touch `sw.js` would pin every installed user to stale code
permanently. So the revision is a sha256 over the bytes of every precached
file, `npm run pwa:rev` writes it, and `npm test` fails until it agrees. Any
asset edit now forces a worker change, which forces a real update. This is
content-addressing without a build step, and it caught a genuine drift during
implementation.

**Why navigations are network-first.** `index.html` carries the Content
Security Policy, since GitHub Pages cannot send headers. Serving it cache-first
would pin a security-relevant document until the next worker update. A 2.5s
timeout bounds the cost on a slow network, and the app needs YouTube to do
anything beyond browsing anyway.

**Why the cache is precache-only.** A runtime-caching miss path would let the
cache diverge from `SHELL`, grow without bound, and make `SHELL_REVISION` stop
describing its contents. A miss goes to the network and is not stored.

**Why registration is not gated to production.** The obvious move was to skip
registration on localhost so `npm run dev` never serves stale files. That would
mean the deployed code path is never the one under test. Instead the worker
registers everywhere, `e2e/conftest.py` blocks service workers for every suite
that is not testing them, and `updateViaCache: 'none'` plus a hard reload
covers development.

## Consequences

**Cache Storage widens the shared-origin problem.** The README already warns
that a project site shares its origin with every other project page on the same
`github.io` account, and that IndexedDB is therefore readable by any of them.
Cache Storage is scoped the same way, and the consequence is worse: another
page on the account can write a poisoned `app.js` into this app's cache, and the
worker will serve it as same-origin script. A worker served from the account
root can additionally take scope `/` and intercept everything under
`/CourseTracker/`. This is a code-execution path that did not exist before this
change, and it makes the existing "use a custom domain or a dedicated account"
recommendation substantially stronger rather than merely tidy.

**GitHub Pages sends `Cache-Control: max-age=600`.** The worker script itself
bypasses the HTTP cache, but precache fetches would not, so they are issued with
`cache: 'reload'`. A deploy can still be up to ten minutes stale for a returning
user before the worker even looks.

**`sw.js` runs with no CSP.** A worker's policy comes from headers on its own
response, and Pages sends none, so the meta CSP in `index.html` constrains
nothing inside it. The file is kept short enough to audit by eye.

**Offline is partial, and the app says so.** The shell, the library, progress,
tag editing, and backup export all work with no network. Playlist discovery and
playback never will, because both are YouTube. The install section states this
where the promise is made, and one strip in the app shell states it in context.

## Revisit when

- A second cached origin or a real offline video story appears, at which point
  precache-only stops being sufficient.
- Anything else is deployed to the same `github.io` account, which makes the
  Cache Storage consequence above live rather than theoretical.
- `SHELL` grows past what is reasonable to precache on a first visit.
