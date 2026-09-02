# CourseTracker

CourseTracker is a mobile-friendly, local-first web app for treating YouTube playlists as self-paced courses. It is a completely static site: there is no CourseTracker server, no account system, and no YouTube Data API key.

A playlist becomes one course. CourseTracker stores tags, watched state, current lesson, and resume positions in IndexedDB. YouTube remains the source of truth for the playlist itself.

## What v1 does

- Add one or several public YouTube playlist URLs.
- Import playlist URLs from `.txt` or simple JSON lists.
- Discover playlist video IDs with the YouTube IFrame Player API, without an API key.
- Watch inside CourseTracker or open the same lesson on YouTube with playlist context preserved.
- Automatically mark a lesson watched at 95% or the YouTube `ENDED` event.
- Manually mark lessons watched or unwatched.
- Save resume position while playing and on pause/navigation.
- Show a Continue Learning dashboard for recent incomplete courses.
- Search, sort, and filter courses with multiple AND-combined tags.
- Manually refresh a playlist while preserving progress by YouTube video ID.
- Confirm before a refresh retires a large share of a course, because a
  partially loaded playlist is indistinguishable from a deletion.
- Keep removed lessons as hidden history instead of deleting progress.
- Rename a course, edit its tags, or delete it (with undo).
- Export, share, merge, or replace the local library with a versioned JSON backup.
- Delete all local data from Settings.
- Work from a repository subpath on GitHub Pages using hash routes.

## Architecture

The shipped app under `site/` uses browser-native ES modules and IndexedDB. It
has no runtime or build-time JavaScript dependencies; the only dev dependency is
`fake-indexeddb`, used by the storage unit tests.

This departs from the approved plan, which specified React, Vite, Dexie and Zod.
The reasoning is recorded in
[`docs/decisions/0001-vanilla-es-modules-instead-of-react.md`](docs/decisions/0001-vanilla-es-modules-instead-of-react.md).

### Rendering rules

These are load-bearing. Breaking them reintroduces bugs the regression suite was
written to catch:

1. **Pages build their DOM once and patch it in place.** Never call
   `replaceChildren()` on a container that holds focus, a caret, or an iframe.
2. **Lists go through `reconcileList`,** which reuses nodes by key.
3. **The player subtree is never detached.** Moving an iframe reloads it — even
   re-appending it to the same parent. Lesson changes call `load()` on the live
   handle; the player is mounted once per course page.
4. **Progress is polled, not awaited.** The IFrame API fires no events during
   uninterrupted playback, so the autosave loop reads `playerHandle.snapshot()`
   rather than replaying the last event.
5. **Text reaches the DOM only through `text` / `setText`.** `h()` throws on
   `innerHTML`, `outerHTML`, `srcdoc`, and string event handlers. Course
   titles, tags, and lesson names come from YouTube responses and imported
   backup files, so this rule is what keeps them inert. URLs built from data go
   through `encodeURIComponent` behind a host allowlist.

```text
site/
  index.html          Static entry point
  styles.css          Mobile-first visual system
  src/
    app.js            Hash router, storage gate, global shell
    domain.js         Progress, tags, filtering, refresh rules, mass-removal guard
    storage.js        IndexedDB persistence and transactions
    youtube.js        Playlist discovery, metadata, player adapter
    backup.js         Versioned backup validation/merge/replace
    view-models.js    Pure page derivations
    pages/
      library.js      Continue Learning + searchable library
      add.js          Bulk playlist import
      course.js       Player, progress, refresh, lesson list
      settings.js     Backup/restore/share + privacy copy
```

The approved product design and original implementation plan are retained in `docs/superpowers/`.

## Run locally

No install step is required for the app itself.

```bash
npm run dev
```

Then open `http://localhost:4173`.

The unit suite uses Node's built-in test runner and needs one dev dependency:

```bash
npm install
npm test
```

Browser tests use Python Playwright:

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run e2e
```

Run the full verification gate with:

```bash
npm run check
```

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` tests the app, uploads the `site/` directory, and deploys it with GitHub Pages. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

All application links are hash routes such as `#/course/<id>`, so refreshing a course screen never requires a server rewrite rule.

## Data and privacy

All durable CourseTracker data lives in the current browser's IndexedDB database named `course-tracker`. CourseTracker has no server and does not send progress or tags anywhere. Settings has a control to delete all of it.

The browser still contacts YouTube. Discovery and playback embed from
`www.youtube-nocookie.com`, though the IFrame API bootstrap it loads fetches
its widget script from `www.youtube.com`. Thumbnails come from `i.ytimg.com`,
and the optional title lookup uses the oEmbed endpoint on `www.youtube.com`,
which is the only host that serves it — so YouTube can still see which videos
you look up. "Open on YouTube" links deliberately point at `www.youtube.com` so
they work in the YouTube app.

`site/index.html` carries a Content Security Policy in a `<meta>` tag that
allows exactly those hosts. GitHub Pages cannot send response headers, so this
is the only place it can live; `frame-ancestors` is ignored in meta and
therefore absent.

**Shared origin on GitHub Pages.** A project site at
`https://<user>.github.io/CourseTracker/` shares its origin with every other
project page on `<user>.github.io`. IndexedDB and `sessionStorage` are scoped
to the origin, so any other site deployed on the same account can read or
erase this library, and a script-injection bug in one of them affects all of
them. If the account hosts anything else, serve CourseTracker from a custom
domain or a dedicated account.

The E2E test adapter (`?e2e=1`) is honoured only on `localhost`, `127.0.0.1`,
and `[::1]`, so a shared link cannot switch the deployed app into test mode.

A metadata failure does not prevent core tracking because video IDs are the durable lesson identity.

For another device, export a CourseTracker backup and transfer the JSON file with download or the browser's native file-sharing UI when supported.

## Real YouTube smoke test

Automated browser tests use a deterministic YouTube adapter so CI does not depend on live YouTube behavior. Before a release:

1. Run `npm run dev` in a normal browser session with network access.
2. Add one public YouTube playlist using its real playlist URL.
3. Confirm discovery returns an ordered lesson list without an API key.
4. Open one embeddable lesson and confirm playback starts.
5. Seek beyond 95%, leave the course, return, and confirm watched/resume state persisted.
6. Click **Refresh playlist** and confirm the refresh completes without losing existing progress.
7. Open one lesson on YouTube and confirm the generated URL contains both `v=` and `list=`.
8. Play a lesson for two minutes **without pausing**, then navigate away and
   back. The resume position must reflect the time watched. Automated tests
   cover this against a simulated player, but the polling path depends on the
   real `getCurrentTime()`.
9. Confirm playback works from `www.youtube-nocookie.com`. This host is not
   exercised by the browser tests, which use a stub player.
   Keep the DevTools console open for steps 2–9 and confirm there are **no
   Content Security Policy violations**. If YouTube has started serving the
   player or widget script from another host, add it to the CSP in
   `site/index.html` rather than loosening a directive.
10. **Add a playlist with more than 250 videos** and check how many lessons
    discovery returns. The embedded player may cap the list. If it does, note the
    cap here — a truncated discovery would otherwise look like a mass deletion on
    refresh. The mass-removal confirmation guards against silent data loss, but
    the underlying cap still needs to be known.

A metadata/oEmbed failure is acceptable if video IDs, embedded/open-on-YouTube playback, and progress tracking still work.

## Testing

```bash
npm test        # unit + contract, Node test runner
npm run e2e     # browser tests, Python Playwright
npm run check   # both
```

`e2e/test_regressions.py` guards the defects found in the September 2026 audit —
resume tracking, focus survival, player-instance stability, layout overflow, and
the destructive-action confirmations. Those tests assert on observable behaviour
and on stored state; they should not be relaxed to make a change pass.

The browser fixture **fails** rather than skips when Chromium is unavailable. An
earlier version skipped silently, which let a failing suite report success.

The E2E player adapter deliberately models the real IFrame API: time advances
without firing events, and only state transitions emit. Do not add an
"emit a snapshot on demand" helper — that is what previously hid the resume bug.

## Browser support

CourseTracker needs IndexedDB and modern ES module support. If IndexedDB is disabled or unavailable (for example, by a restrictive browsing mode), the app shows a blocking explanation instead of silently losing progress.

## v1 non-goals

No accounts, cloud sync, background refresh, notes, ratings, favorites, multi-playlist courses, playlist editing, arbitrary single-video courses, offline video playback, or native apps.

A configurable completion threshold is also out of scope. v1 stored one in an
IndexedDB `settings` store that nothing read; the v2 schema migration removes it.
