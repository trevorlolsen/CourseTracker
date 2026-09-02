# ADR 0001 — Vanilla ES modules instead of the planned React stack

- **Status:** Accepted
- **Date:** 2026-09-02
- **Supersedes:** the Tech Stack line in `docs/superpowers/plans/2026-09-02-youtube-course-tracker-v1.md`

## Context

The approved plan specified React + TypeScript + Vite, React Router `HashRouter`,
Dexie, Zod, CSS Modules, Vitest + React Testing Library + `fake-indexeddb`, and
`@playwright/test`. What shipped in v1 was vanilla ES modules with a hand-rolled
`h()` helper, hand-rolled IndexedDB access, hand-rolled backup validation,
`node:test`, and Python Playwright. No decision record existed, and the README
presented "no runtime or build-time JavaScript package dependencies" as a design
feature rather than a departure from the approved design.

The September 2026 audit found that six defects (search focus loss, invisible
auto-completion, an inverted watched button, player teardown on every state
change, stale lesson titles, and caret loss in the add form) shared one cause:
imperative `container.replaceChildren()` rendering that destroyed live state and
separately failed to reflect state changes. That is precisely the bug class a
declarative view layer removes by construction.

## Decision

Keep vanilla ES modules for v1, and adopt an explicit render discipline instead
of a framework:

- Each page builds its DOM **once** and patches it in place.
- Lists are updated through a keyed `reconcileList` helper rather than rebuilt.
- The YouTube player subtree is never detached. Lesson changes call `load()` on
  the live handle.
- The router hands query-only changes to the live page via `onQueryChange`
  rather than tearing the page down.

## Rationale

**Why not port now.** The e2e suite was the only contract a port could be
checked against, and it did not work: four of ten tests failed deterministically
and the fixture silently skipped the whole suite when a browser was unavailable.
Porting before that was fixed would have meant porting broken behaviour with no
way to distinguish port regressions from pre-existing bugs.

**Why vanilla is defensible.** The deploy story is genuinely simpler: the
workflow uploads `site/` and is done. Adding Vite introduces a build step
between the source and the deployed artifact for an app of roughly 2,000 lines.
The `domain.js` / `storage.js` / `backup.js` / `view-models.js` layers were
already pure and well tested; the framework would only have helped the ~750
lines of page code.

**What this costs.** The render discipline above is a convention, not a
guarantee. Nothing in the language stops a future contributor from calling
`replaceChildren()` on a container holding focus or an iframe. That risk is
carried by the regression tests in `e2e/test_regressions.py`, which assert
player-instance stability and input focus survival directly.

## Constraint discovered while implementing

Moving an iframe in the DOM reloads it — including re-appending it to the *same*
parent (verified in Chromium 141: the embedded document's load counter goes from
1 to 2 in both cases). So caching the player host node and re-inserting it is not
a viable shortcut. This is why the persistent-skeleton approach is mandatory
rather than merely preferable, and it would apply equally to a React port, which
would need the player behind a stable component with a `ref` and no key churn.

## Revisit when

- The page layer grows past roughly 1,500 lines, or
- A third contributor joins and the render convention needs enforcement the
  language can provide, or
- A regression of the class listed above reaches `main` despite the tests.

At that point the port is cheap: the four pure modules carry over unchanged, and
`e2e/` becomes the acceptance contract for the port.
