# CourseTracker v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-friendly, static GitHub Pages web app that imports YouTube playlists as local courses, tracks lesson progress and resume position in IndexedDB, supports tagging/search/manual refresh, and transfers the library between devices with versioned backup files.

**Architecture:** Keep YouTube integration, IndexedDB persistence, and course business rules behind independent TypeScript interfaces. React feature modules compose those units into hash-routed screens; the app never requires a backend, account, or YouTube Data API key, and all durable user state lives in IndexedDB through Dexie.

**Tech Stack:** React + TypeScript + Vite; React Router `HashRouter`; Dexie/IndexedDB; Zod for backup validation; CSS Modules; Vitest + React Testing Library + `fake-indexeddb`; Playwright; GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-09-02-youtube-course-tracker-design.md`

**Repository assumption:** This plan starts from a new/empty CourseTracker repository. If a repository already exists at execution time, preserve its established conventions where they do not conflict with the approved spec.

## Global Constraints

- The application is static: no backend, no user accounts, no API keys, and no server-side operations.
- One YouTube playlist equals one course; YouTube owns playlist ordering/content and CourseTracker owns local progress, resume state, tags, and organization.
- Playlist contents change only through the explicit **Refresh playlist** action; there is no automatic/background refresh.
- All durable application state is stored in IndexedDB. If IndexedDB is unavailable, show a blocking error rather than silently using transient memory.
- Core course behavior must depend on YouTube video IDs, not metadata. Titles/thumbnails are best-effort enrichment only.
- A lesson becomes watched at the YouTube `ENDED` event or when valid playback reaches `currentTime / duration >= 0.95`.
- Persist playback resume position approximately every 5 seconds and on pause, video change, visibility change, and course navigation.
- Completion is `watched active lessons / active lessons`; removed lessons remain historical records but are excluded from the denominator.
- Tags are free-form, case-insensitively unique, preserve the most recent display casing, and multi-tag filtering uses AND semantics.
- Backup merge identity is `playlistId` for courses and `(playlistId, videoId)` for lessons. Newest `progressUpdatedAt` wins progress; newest `metadataUpdatedAt` wins course title/tags.
- Use hash routing: `#/`, `#/course/<courseId>`, `#/add`, `#/settings`.
- Mobile-first breakpoints: `<768px` stacked/player-first, `>=768px` wider layouts, `>=1024px` two-column player + lesson list.
- Avoid hover-only interactions; minimum touch target is approximately 44px; respect `prefers-reduced-motion`.
- v1 excludes notes, ratings, favorites, playlist editing, multi-playlist courses, arbitrary single-video courses, accounts/sync, offline playback, extensions, and native apps.

---

## Planned File Structure

```text
.
├── .github/workflows/deploy-pages.yml
├── docs/superpowers/specs/2026-09-02-youtube-course-tracker-design.md
├── docs/superpowers/plans/2026-09-02-youtube-course-tracker-v1.md
├── e2e/
│   ├── add-course.spec.ts
│   ├── course-progress.spec.ts
│   ├── refresh.spec.ts
│   ├── backup.spec.ts
│   └── mobile.spec.ts
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── App.test.tsx
│   │   └── routes.tsx
│   ├── db/
│   │   ├── database.ts
│   │   ├── repositories.ts
│   │   ├── repositories.test.ts
│   │   ├── backup.ts
│   │   └── backup.test.ts
│   ├── domain/
│   │   ├── types.ts
│   │   ├── progress.ts
│   │   ├── progress.test.ts
│   │   ├── tags.ts
│   │   ├── tags.test.ts
│   │   ├── refresh.ts
│   │   ├── refresh.test.ts
│   │   ├── library.ts
│   │   └── library.test.ts
│   ├── youtube/
│   │   ├── types.ts
│   │   ├── urls.ts
│   │   ├── urls.test.ts
│   │   ├── iframeApi.ts
│   │   ├── iframePlaylistSource.ts
│   │   ├── metadata.ts
│   │   ├── metadata.test.ts
│   │   ├── playerAdapter.ts
│   │   └── youtube-iframe.d.ts
│   ├── features/
│   │   ├── import/
│   │   │   ├── AddCoursePage.tsx
│   │   │   ├── AddCoursePage.module.css
│   │   │   └── AddCoursePage.test.tsx
│   │   ├── library/
│   │   │   ├── LibraryPage.tsx
│   │   │   ├── LibraryPage.module.css
│   │   │   └── LibraryPage.test.tsx
│   │   ├── course/
│   │   │   ├── CoursePage.tsx
│   │   │   ├── CoursePage.module.css
│   │   │   ├── CoursePage.test.tsx
│   │   │   ├── LessonList.tsx
│   │   │   └── YouTubePlayer.tsx
│   │   └── settings/
│   │       ├── SettingsPage.tsx
│   │       ├── SettingsPage.module.css
│   │       └── SettingsPage.test.tsx
│   ├── styles/
│   │   ├── tokens.css
│   │   └── globals.css
│   ├── test/
│   │   └── setup.ts
│   └── main.tsx
├── index.html
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

The file boundaries above are intentional: `domain/` is pure logic, `db/` knows IndexedDB but not YouTube, `youtube/` knows YouTube but not IndexedDB, and `features/` orchestrates those interfaces for UI flows.

---

### Task 1: Create the static application shell and hash routes

**Files:**
- Create/modify: `package.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `src/main.tsx`
- Create: `src/app/App.tsx`, `src/app/routes.tsx`, `src/app/App.test.tsx`
- Create: `src/styles/tokens.css`, `src/styles/globals.css`, `src/test/setup.ts`

**Interfaces:**
- Consumes: none; this is the project baseline.
- Produces: `App`, hash routes for `/`, `/course/:courseId`, `/add`, `/settings`, shared design tokens, and test commands used by every later task.

- [ ] **Step 1: Scaffold the Vite React/TypeScript project and install the baseline dependencies**

Run from the repository root:

```bash
npm create vite@latest . -- --template react-ts
npm install react-router-dom dexie zod
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event fake-indexeddb @playwright/test
npx playwright install chromium
```

Update `package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "check": "npm run test && npm run build && npm run e2e"
  }
}
```

- [ ] **Step 2: Write the failing route smoke test**

Create `src/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App'

afterEach(() => {
  window.location.hash = '#/'
})

describe('App routing', () => {
  it('renders the library route by default', async () => {
    window.location.hash = '#/'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /course tracker/i })).toBeInTheDocument()
  })

  it('renders the add route', async () => {
    window.location.hash = '#/add'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /add course/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Configure Vitest and verify the smoke test fails**

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
})
```

Run:

```bash
npm test -- src/app/App.test.tsx
```

Expected: FAIL because `App` and the requested route content do not exist yet.

- [ ] **Step 4: Implement the minimal application shell and hash routes**

Create `src/app/routes.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'

function LibraryPlaceholder() {
  return <main><h1>CourseTracker</h1></main>
}

function AddPlaceholder() {
  return <main><h1>Add Course</h1></main>
}

function CoursePlaceholder() {
  return <main><h1>Course</h1></main>
}

function SettingsPlaceholder() {
  return <main><h1>Settings</h1></main>
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LibraryPlaceholder />} />
      <Route path="/course/:courseId" element={<CoursePlaceholder />} />
      <Route path="/add" element={<AddPlaceholder />} />
      <Route path="/settings" element={<SettingsPlaceholder />} />
    </Routes>
  )
}
```

Create `src/app/App.tsx`:

```tsx
import { HashRouter } from 'react-router-dom'
import { AppRoutes } from './routes'

export function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}
```

Create `src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/tokens.css'
import './styles/globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

Create `src/styles/tokens.css`:

```css
:root {
  color-scheme: dark;
  --bg: #07111b;
  --surface: #0f1a24;
  --surface-raised: #162330;
  --text: #f7f8fb;
  --text-muted: #aeb8c4;
  --accent: #7c4dff;
  --accent-strong: #906dff;
  --success: #4fbf73;
  --danger: #ef6a6a;
  --border: #263442;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --touch-target: 44px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Create `src/styles/globals.css`:

```css
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--text); }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--bg); }
button, input, select { font: inherit; }
button, a { min-height: var(--touch-target); }
:focus-visible { outline: 3px solid var(--accent-strong); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
}
```

- [ ] **Step 5: Configure asset base handling for GitHub Pages**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const githubProjectBase = repositoryName && !repositoryName.endsWith('.github.io')
  ? `/${repositoryName}/`
  : '/'

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? githubProjectBase : '/',
})
```

- [ ] **Step 6: Run the task verification**

Run:

```bash
npm test -- src/app/App.test.tsx
npm run build
```

Expected: both commands PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vite.config.ts vitest.config.ts playwright.config.ts src index.html tsconfig*.json
git commit -m "chore: scaffold static CourseTracker app"
```

---

### Task 2: Define the domain model and pure course rules

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/progress.ts`, `src/domain/progress.test.ts`
- Create: `src/domain/tags.ts`, `src/domain/tags.test.ts`
- Create: `src/domain/library.ts`, `src/domain/library.test.ts`
- Create: `src/domain/refresh.ts`, `src/domain/refresh.test.ts`

**Interfaces:**
- Consumes: none beyond TypeScript.
- Produces: `Course`, `CourseVideo`, `calculateCourseProgress`, `shouldAutoComplete`, `selectContinueVideo`, `normalizeTags`, `matchesSelectedTags`, `filterCourses`, `diffPlaylist`.

- [ ] **Step 1: Define stable domain types**

Create `src/domain/types.ts`:

```ts
export type TitleSource = 'youtube' | 'user' | 'fallback'
export type EmbedStatus = 'unknown' | 'playable' | 'unavailable' | 'restricted'

export interface Course {
  id: string
  playlistId: string
  sourceUrl: string
  title: string
  titleSource: TitleSource
  authorName?: string
  thumbnailVideoId?: string
  tags: string[]
  currentVideoId?: string
  createdAt: number
  updatedAt: number
  metadataUpdatedAt: number
  lastOpenedAt?: number
  lastRefreshedAt?: number
}

export interface CourseVideo {
  courseId: string
  videoId: string
  position: number
  title?: string
  authorName?: string
  thumbnailUrl?: string
  durationSeconds?: number
  watched: boolean
  resumeSeconds: number
  progressUpdatedAt: number
  firstSeenAt: number
  lastSeenAt: number
  removedAt?: number
  embedStatus: EmbedStatus
}

export interface CourseWithVideos {
  course: Course
  videos: CourseVideo[]
}
```

- [ ] **Step 2: Write failing progress tests**

Create `src/domain/progress.test.ts` with cases for the 95% rule, removed-video denominator, and continue selection:

```ts
import { describe, expect, it } from 'vitest'
import type { CourseVideo } from './types'
import { calculateCourseProgress, selectContinueVideo, shouldAutoComplete } from './progress'

const video = (videoId: string, position: number, watched = false, removedAt?: number): CourseVideo => ({
  courseId: 'c1', videoId, position, watched, removedAt, resumeSeconds: 0,
  progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown',
})

describe('progress rules', () => {
  it('auto-completes at 95 percent or ended', () => {
    expect(shouldAutoComplete({ currentTime: 94.9, duration: 100, ended: false })).toBe(false)
    expect(shouldAutoComplete({ currentTime: 95, duration: 100, ended: false })).toBe(true)
    expect(shouldAutoComplete({ currentTime: 0, duration: 0, ended: true })).toBe(true)
  })

  it('excludes removed lessons from completion', () => {
    expect(calculateCourseProgress([video('a', 0, true), video('b', 1, false), video('old', 2, false, 99)]))
      .toEqual({ watched: 1, active: 2, percent: 50 })
  })

  it('advances from a watched current lesson to the next unwatched lesson', () => {
    const videos = [video('a', 0, true), video('b', 1, false), video('c', 2, false)]
    expect(selectContinueVideo(videos, 'a')?.videoId).toBe('b')
  })
})
```

- [ ] **Step 3: Run the progress tests and verify failure**

```bash
npm test -- src/domain/progress.test.ts
```

Expected: FAIL because `progress.ts` does not exist.

- [ ] **Step 4: Implement the minimal progress rules**

Create `src/domain/progress.ts`:

```ts
import type { CourseVideo } from './types'

export const COMPLETION_THRESHOLD = 0.95

export function shouldAutoComplete(input: { currentTime: number; duration: number; ended: boolean }): boolean {
  if (input.ended) return true
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false
  return input.currentTime / input.duration >= COMPLETION_THRESHOLD
}

export function calculateCourseProgress(videos: CourseVideo[]) {
  const active = videos.filter((item) => item.removedAt === undefined)
  const watched = active.filter((item) => item.watched).length
  const percent = active.length === 0 ? 0 : Math.round((watched / active.length) * 100)
  return { watched, active: active.length, percent }
}

export function selectContinueVideo(videos: CourseVideo[], currentVideoId?: string): CourseVideo | undefined {
  const active = [...videos].filter((item) => item.removedAt === undefined).sort((a, b) => a.position - b.position)
  const currentIndex = active.findIndex((item) => item.videoId === currentVideoId)
  if (currentIndex >= 0 && !active[currentIndex].watched) return active[currentIndex]
  if (currentIndex >= 0) {
    const after = active.slice(currentIndex + 1).find((item) => !item.watched)
    if (after) return after
  }
  return active.find((item) => !item.watched) ?? active[currentIndex] ?? active[0]
}
```

- [ ] **Step 5: Write failing tag and library tests**

Create `src/domain/tags.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchesSelectedTags, normalizeTags } from './tags'

describe('tag rules', () => {
  it('deduplicates case-insensitively and keeps the latest display casing', () => {
    expect(normalizeTags([' Rust ', 'WEB dev', 'rust'])).toEqual(['WEB dev', 'rust'])
  })

  it('uses AND semantics for selected tags', () => {
    expect(matchesSelectedTags(['Rust', 'Beginner'], ['rust', 'BEGINNER'])).toBe(true)
    expect(matchesSelectedTags(['Rust'], ['Rust', 'Beginner'])).toBe(false)
  })
})
```

Create `src/domain/library.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Course } from './types'
import { filterCourses } from './library'

const course = (title: string, tags: string[]): Course => ({
  id: title, playlistId: title, sourceUrl: '', title, titleSource: 'user', tags,
  createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1,
})

describe('library filtering', () => {
  it('matches title and tags case-insensitively', () => {
    const result = filterCourses([course('Rust Fundamentals', ['Systems']), course('Statistics', ['Math'])], {
      query: 'rust', selectedTags: ['systems'], status: 'all', sort: 'title', progressByCourseId: new Map(),
    })
    expect(result.map((item) => item.id)).toEqual(['Rust Fundamentals'])
  })
})
```

- [ ] **Step 6: Implement tags and library filtering**

Create `src/domain/tags.ts`:

```ts
const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

export function normalizeTags(tags: string[]): string[] {
  const values = new Map<string, string>()
  for (const raw of tags) {
    const display = raw.trim().replace(/\s+/g, ' ')
    if (!display) continue
    const normalized = key(display)
    if (values.has(normalized)) values.delete(normalized)
    values.set(normalized, display)
  }
  return [...values.values()]
}

export function matchesSelectedTags(courseTags: string[], selectedTags: string[]): boolean {
  const courseKeys = new Set(courseTags.map(key))
  return selectedTags.every((tag) => courseKeys.has(key(tag)))
}
```

Create `src/domain/library.ts`:

```ts
import type { Course } from './types'
import { matchesSelectedTags } from './tags'

export type LibraryStatus = 'all' | 'in-progress' | 'completed'
export type LibrarySort = 'recent' | 'title' | 'progress'

export interface CourseProgressSummary { watched: number; active: number; percent: number }

export interface LibraryFilter {
  query: string
  selectedTags: string[]
  status: LibraryStatus
  sort: LibrarySort
  progressByCourseId: Map<string, CourseProgressSummary>
}

export function filterCourses(courses: Course[], filter: LibraryFilter): Course[] {
  const q = filter.query.trim().toLocaleLowerCase()
  const result = courses.filter((course) => {
    const progress = filter.progressByCourseId.get(course.id) ?? { watched: 0, active: 0, percent: 0 }
    const searchable = [course.title, course.authorName ?? '', ...course.tags].join(' ').toLocaleLowerCase()
    const statusMatches = filter.status === 'all'
      || (filter.status === 'completed' && progress.active > 0 && progress.percent === 100)
      || (filter.status === 'in-progress' && progress.active > 0 && progress.percent < 100)
    return (!q || searchable.includes(q)) && matchesSelectedTags(course.tags, filter.selectedTags) && statusMatches
  })

  return result.sort((a, b) => {
    const pa = filter.progressByCourseId.get(a.id)?.percent ?? 0
    const pb = filter.progressByCourseId.get(b.id)?.percent ?? 0
    if (filter.sort === 'title') return a.title.localeCompare(b.title)
    if (filter.sort === 'progress') return pb - pa
    return (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt)
  })
}
```

- [ ] **Step 7: Write the failing playlist refresh diff test**

Create `src/domain/refresh.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CourseVideo } from './types'
import { diffPlaylist } from './refresh'

const oldVideo = (videoId: string, position: number, removedAt?: number): CourseVideo => ({
  courseId: 'c1', videoId, position, watched: videoId === 'keep', resumeSeconds: videoId === 'keep' ? 33 : 0,
  progressUpdatedAt: 10, firstSeenAt: 1, lastSeenAt: 2, removedAt, embedStatus: 'unknown',
})

describe('diffPlaylist', () => {
  it('preserves progress, adds new IDs, removes missing IDs, and reactivates returning IDs', () => {
    const result = diffPlaylist([oldVideo('keep', 0), oldVideo('gone', 1), oldVideo('back', 2, 5)], ['back', 'keep', 'new'], 100)
    expect(result.summary).toEqual({ added: 1, removed: 1, unchanged: 2, duplicateIds: [] })
    expect(result.videos.find((v) => v.videoId === 'keep')).toMatchObject({ watched: true, resumeSeconds: 33, position: 1 })
    expect(result.videos.find((v) => v.videoId === 'back')?.removedAt).toBeUndefined()
    expect(result.videos.find((v) => v.videoId === 'gone')?.removedAt).toBe(100)
  })
})
```

- [ ] **Step 8: Implement playlist refresh diffing**

Create `src/domain/refresh.ts`:

```ts
import type { CourseVideo } from './types'

export interface RefreshSummary { added: number; removed: number; unchanged: number; duplicateIds: string[] }

export function diffPlaylist(existing: CourseVideo[], discoveredIds: string[], now: number): { videos: CourseVideo[]; summary: RefreshSummary } {
  const seen = new Set<string>()
  const duplicateIds: string[] = []
  const orderedIds = discoveredIds.filter((id) => {
    if (seen.has(id)) { duplicateIds.push(id); return false }
    seen.add(id)
    return true
  })
  const existingById = new Map(existing.map((item) => [item.videoId, item]))
  let added = 0
  let unchanged = 0

  const active = orderedIds.map((videoId, position): CourseVideo => {
    const prior = existingById.get(videoId)
    if (prior) {
      unchanged += 1
      return { ...prior, position, removedAt: undefined, lastSeenAt: now }
    }
    added += 1
    return {
      courseId: existing[0]?.courseId ?? '', videoId, position, watched: false, resumeSeconds: 0,
      progressUpdatedAt: now, firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown',
    }
  })

  const removed = existing
    .filter((item) => !seen.has(item.videoId))
    .map((item) => item.removedAt === undefined ? { ...item, removedAt: now } : item)

  const newlyRemoved = removed.filter((item) => item.removedAt === now).length
  return { videos: [...active, ...removed], summary: { added, removed: newlyRemoved, unchanged, duplicateIds } }
}
```

- [ ] **Step 9: Verify all domain tests**

```bash
npm test -- src/domain
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/domain
git commit -m "feat: define course tracking domain rules"
```

---

### Task 3: Add Dexie persistence and repository transactions

**Files:**
- Create: `src/db/database.ts`
- Create: `src/db/repositories.ts`
- Create: `src/db/repositories.test.ts`

**Interfaces:**
- Consumes: `Course`, `CourseVideo` from `src/domain/types.ts`.
- Produces: `CourseTrackerDatabase`, `CourseRepository`, `CourseVideoRepository`, and `CourseStore` transaction methods used by every feature.

- [ ] **Step 1: Write failing repository tests**

Create `src/db/repositories.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CourseTrackerDatabase } from './database'
import { CourseStore } from './repositories'

let db: CourseTrackerDatabase
let store: CourseStore

beforeEach(() => {
  db = new CourseTrackerDatabase(`test-${crypto.randomUUID()}`)
  store = new CourseStore(db)
})

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('CourseStore', () => {
  it('creates a course with videos atomically and finds it by playlist id', async () => {
    const now = 100
    const course = {
      id: 'c1', playlistId: 'PL1', sourceUrl: 'https://youtube.com/playlist?list=PL1', title: 'Course',
      titleSource: 'user' as const, tags: ['Rust'], createdAt: now, updatedAt: now, metadataUpdatedAt: now,
    }
    await store.createCourse(course, [{
      courseId: 'c1', videoId: 'v1', position: 0, watched: false, resumeSeconds: 0,
      progressUpdatedAt: now, firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown' as const,
    }])
    expect((await store.getCourseByPlaylistId('PL1'))?.id).toBe('c1')
    expect((await store.getCourseVideos('c1')).map((v) => v.videoId)).toEqual(['v1'])
  })

  it('updates watched and resume state without rewriting metadata', async () => {
    const now = 100
    await store.createCourse({
      id: 'c1', playlistId: 'PL1', sourceUrl: '', title: 'Course', titleSource: 'user', tags: [],
      createdAt: now, updatedAt: now, metadataUpdatedAt: now,
    }, [{
      courseId: 'c1', videoId: 'v1', position: 0, title: 'Lesson', watched: false, resumeSeconds: 0,
      progressUpdatedAt: now, firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown',
    }])
    await store.updateProgress('c1', 'v1', { watched: true, resumeSeconds: 42, progressUpdatedAt: 200 })
    expect(await store.getCourseVideo('c1', 'v1')).toMatchObject({
      title: 'Lesson', watched: true, resumeSeconds: 42, progressUpdatedAt: 200,
    })
  })
})
```

- [ ] **Step 2: Run repository tests and verify failure**

```bash
npm test -- src/db/repositories.test.ts
```

Expected: FAIL because the database and store are undefined.

- [ ] **Step 3: Implement the Dexie schema**

Create `src/db/database.ts`:

```ts
import Dexie, { type EntityTable } from 'dexie'
import type { Course, CourseVideo } from '../domain/types'

export interface SettingRecord { key: string; value: unknown }

export class CourseTrackerDatabase extends Dexie {
  courses!: EntityTable<Course, 'id'>
  courseVideos!: EntityTable<CourseVideo, '[courseId+videoId]'>
  settings!: EntityTable<SettingRecord, 'key'>

  constructor(name = 'course-tracker') {
    super(name)
    this.version(1).stores({
      courses: 'id,&playlistId,lastOpenedAt,updatedAt',
      courseVideos: '[courseId+videoId],courseId,videoId,[courseId+position],removedAt,progressUpdatedAt',
      settings: 'key',
    })
  }
}

export const db = new CourseTrackerDatabase()
```

- [ ] **Step 4: Implement the repository facade**

Create `src/db/repositories.ts`:

```ts
import type { Course, CourseVideo } from '../domain/types'
import type { CourseTrackerDatabase } from './database'

export class CourseStore {
  constructor(private readonly db: CourseTrackerDatabase) {}

  async createCourse(course: Course, videos: CourseVideo[]): Promise<void> {
    await this.db.transaction('rw', this.db.courses, this.db.courseVideos, async () => {
      await this.db.courses.add(course)
      await this.db.courseVideos.bulkAdd(videos)
    })
  }

  getCourse(id: string) { return this.db.courses.get(id) }
  getCourseByPlaylistId(playlistId: string) { return this.db.courses.where('playlistId').equals(playlistId).first() }
  listCourses() { return this.db.courses.toArray() }
  getCourseVideo(courseId: string, videoId: string) { return this.db.courseVideos.get([courseId, videoId]) }

  async getCourseVideos(courseId: string): Promise<CourseVideo[]> {
    const rows = await this.db.courseVideos.where('courseId').equals(courseId).toArray()
    return rows.sort((a, b) => a.position - b.position)
  }

  async updateCourse(id: string, patch: Partial<Course>): Promise<void> {
    await this.db.courses.update(id, patch)
  }

  async updateProgress(courseId: string, videoId: string, patch: Pick<CourseVideo, 'watched' | 'resumeSeconds' | 'progressUpdatedAt'>): Promise<void> {
    await this.db.courseVideos.update([courseId, videoId], patch)
  }

  async updateVideo(courseId: string, videoId: string, patch: Partial<CourseVideo>): Promise<void> {
    await this.db.courseVideos.update([courseId, videoId], patch)
  }

  async replaceCourseVideos(courseId: string, videos: CourseVideo[]): Promise<void> {
    await this.db.transaction('rw', this.db.courseVideos, async () => {
      await this.db.courseVideos.where('courseId').equals(courseId).delete()
      await this.db.courseVideos.bulkAdd(videos)
    })
  }

  async deleteAll(): Promise<void> {
    await this.db.transaction('rw', this.db.courses, this.db.courseVideos, this.db.settings, async () => {
      await this.db.courseVideos.clear()
      await this.db.courses.clear()
      await this.db.settings.clear()
    })
  }
}
```

- [ ] **Step 5: Add the fixed completion-threshold setting on first open**

In `src/db/database.ts`, add:

```ts
this.on('ready', async () => {
  const existing = await this.settings.get('completionThreshold')
  if (!existing) await this.settings.put({ key: 'completionThreshold', value: 0.95 })
})
```

- [ ] **Step 6: Verify repository behavior**

```bash
npm test -- src/db/repositories.test.ts
```

Expected: PASS, including atomic course/video creation and progress updates.

- [ ] **Step 7: Commit**

```bash
git add src/db/database.ts src/db/repositories.ts src/db/repositories.test.ts
git commit -m "feat: add IndexedDB persistence layer"
```

---

### Task 4: Isolate YouTube URL parsing, playlist discovery, metadata, and links

**Files:**
- Create: `src/youtube/types.ts`, `src/youtube/urls.ts`, `src/youtube/urls.test.ts`
- Create: `src/youtube/youtube-iframe.d.ts`, `src/youtube/iframeApi.ts`, `src/youtube/iframePlaylistSource.ts`
- Create: `src/youtube/metadata.ts`, `src/youtube/metadata.test.ts`

**Interfaces:**
- Consumes: browser DOM/fetch only.
- Produces: `parsePlaylistId`, `canonicalWatchUrl`, `YouTubePlaylistSource.discover`, `YouTubeMetadataSource.enrichVideo`, `thumbnailUrl`.

- [ ] **Step 1: Write failing URL parsing/link tests**

Create `src/youtube/urls.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canonicalWatchUrl, parsePlaylistId } from './urls'

describe('YouTube playlist URLs', () => {
  it.each([
    ['https://www.youtube.com/playlist?list=PL123', 'PL123'],
    ['https://www.youtube.com/watch?v=abc&list=PL123', 'PL123'],
    ['https://youtu.be/abc?list=PL123', 'PL123'],
  ])('extracts playlist id from %s', (input, expected) => {
    expect(parsePlaylistId(input)).toBe(expected)
  })

  it('rejects non-YouTube URLs and missing list ids', () => {
    expect(parsePlaylistId('https://example.com/?list=PL123')).toBeNull()
    expect(parsePlaylistId('https://youtube.com/watch?v=abc')).toBeNull()
  })

  it('keeps playlist context in generated watch links', () => {
    expect(canonicalWatchUrl('video1', 'PL123')).toBe('https://www.youtube.com/watch?v=video1&list=PL123')
  })
})
```

- [ ] **Step 2: Run the URL tests and verify failure**

```bash
npm test -- src/youtube/urls.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement URL parsing and canonical links**

Create `src/youtube/urls.ts`:

```ts
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])

export function parsePlaylistId(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!YOUTUBE_HOSTS.has(url.hostname.toLocaleLowerCase())) return null
    const id = url.searchParams.get('list')?.trim()
    return id || null
  } catch {
    return null
  }
}

export function canonicalPlaylistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
}

export function canonicalWatchUrl(videoId: string, playlistId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(playlistId)}`
}
```

- [ ] **Step 4: Define the YouTube interfaces and minimal IFrame types**

Create `src/youtube/types.ts`:

```ts
export interface PlaylistDiscoveryResult { playlistId: string; videoIds: string[] }
export interface YouTubePlaylistSource { discover(playlistId: string): Promise<PlaylistDiscoveryResult> }
export interface PlaylistMetadata { playlistId: string; title?: string; authorName?: string }
export interface VideoMetadata { videoId: string; title?: string; authorName?: string; thumbnailUrl: string }
export interface YouTubeMetadataSource {
  enrichPlaylist(playlistId: string): Promise<PlaylistMetadata>
  enrichVideo(videoId: string): Promise<VideoMetadata>
}
```

Create `src/youtube/youtube-iframe.d.ts` with only the subset used by this app:

```ts
declare namespace YT {
  const PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; CUED: number }
  class Player {
    constructor(element: HTMLElement | string, options: PlayerOptions)
    cuePlaylist(options: { listType: 'playlist'; list: string }): void
    getPlaylist(): string[] | null
    getVideoData(): { video_id: string; title: string; author: string }
    getCurrentTime(): number
    getDuration(): number
    seekTo(seconds: number, allowSeekAhead: boolean): void
    loadVideoById(videoId: string, startSeconds?: number): void
    destroy(): void
  }
  interface PlayerOptions {
    width?: string | number
    height?: string | number
    videoId?: string
    playerVars?: Record<string, string | number>
    events?: {
      onReady?: (event: { target: Player }) => void
      onStateChange?: (event: { target: Player; data: number }) => void
      onError?: (event: { target: Player; data: number }) => void
    }
  }
}

interface Window {
  YT?: typeof YT
  onYouTubeIframeAPIReady?: () => void
}
```

- [ ] **Step 5: Implement a singleton IFrame API loader and playlist discovery adapter**

Create `src/youtube/iframeApi.ts`:

```ts
let apiPromise: Promise<typeof YT> | undefined

export function loadYouTubeIframeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
      else reject(new Error('YouTube IFrame API did not initialize'))
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => reject(new Error('Unable to load YouTube IFrame API'))
    document.head.appendChild(script)
  })
  return apiPromise
}
```

Create `src/youtube/iframePlaylistSource.ts`:

```ts
import { loadYouTubeIframeApi } from './iframeApi'
import type { PlaylistDiscoveryResult, YouTubePlaylistSource } from './types'

export class IframePlaylistSource implements YouTubePlaylistSource {
  async discover(playlistId: string): Promise<PlaylistDiscoveryResult> {
    const YTApi = await loadYouTubeIframeApi()
    const host = document.createElement('div')
    Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '-10000px', width: '1px', height: '1px' })
    document.body.appendChild(host)

    let player: YT.Player | undefined
    let pollTimer: number | undefined
    try {
      const videoIds = await new Promise<string[]>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          window.clearTimeout(timeout)
          if (pollTimer !== undefined) window.clearTimeout(pollTimer)
          fn()
        }
        const timeout = window.setTimeout(() => {
          finish(() => reject(new Error('Playlist discovery timed out')))
        }, 15_000)

        player = new YTApi.Player(host, {
          height: 1,
          width: 1,
          playerVars: { listType: 'playlist', list: playlistId },
          events: {
            onReady: ({ target }) => {
              target.cuePlaylist({ listType: 'playlist', list: playlistId })
              const poll = () => {
                const ids = target.getPlaylist() ?? []
                if (ids.length > 0) { finish(() => resolve(ids)); return }
                pollTimer = window.setTimeout(poll, 250)
              }
              poll()
            },
            onError: ({ data }) => finish(() => reject(new Error(`Playlist discovery failed with YouTube error ${data}`))),
          },
        })
      })
      return { playlistId, videoIds }
    } finally {
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      player?.destroy()
      host.remove()
    }
  }
}
```

- [ ] **Step 6: Write failing metadata fallback tests**

Create `src/youtube/metadata.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { OEmbedMetadataSource, thumbnailUrl } from './metadata'

describe('YouTube metadata', () => {
  it('derives a deterministic thumbnail URL', () => {
    expect(thumbnailUrl('abc')).toBe('https://i.ytimg.com/vi/abc/hqdefault.jpg')
  })

  it('returns fallback metadata when oEmbed is unavailable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('CORS'))
    const source = new OEmbedMetadataSource(fetcher)
    expect(await source.enrichVideo('abc')).toEqual({ videoId: 'abc', thumbnailUrl: thumbnailUrl('abc') })
  })
})
```

- [ ] **Step 7: Implement best-effort metadata enrichment**

Create `src/youtube/metadata.ts`:

```ts
import type { VideoMetadata, YouTubeMetadataSource } from './types'

export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
}

export class OEmbedMetadataSource implements YouTubeMetadataSource {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async enrichPlaylist(playlistId: string) {
    try {
      const url = new URL('https://www.youtube.com/oembed')
      url.searchParams.set('url', `https://www.youtube.com/playlist?list=${playlistId}`)
      url.searchParams.set('format', 'json')
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) return { playlistId }
      const body = await response.json() as { title?: string; author_name?: string }
      return { playlistId, title: body.title, authorName: body.author_name }
    } catch {
      return { playlistId }
    }
  }

  async enrichVideo(videoId: string): Promise<VideoMetadata> {
    const fallback: VideoMetadata = { videoId, thumbnailUrl: thumbnailUrl(videoId) }
    try {
      const url = new URL('https://www.youtube.com/oembed')
      url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`)
      url.searchParams.set('format', 'json')
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) return fallback
      const body = await response.json() as { title?: string; author_name?: string; thumbnail_url?: string }
      return {
        videoId,
        title: body.title,
        authorName: body.author_name,
        thumbnailUrl: body.thumbnail_url ?? fallback.thumbnailUrl,
      }
    } catch {
      return fallback
    }
  }
}
```

- [ ] **Step 8: Verify YouTube unit tests**

```bash
npm test -- src/youtube/urls.test.ts src/youtube/metadata.test.ts
```

Expected: PASS. Do not add a network-dependent automated test for real playlist discovery; real-IFrame validation belongs in the manual smoke test in Task 11.

- [ ] **Step 9: Commit**

```bash
git add src/youtube
git commit -m "feat: isolate keyless YouTube integration"
```

---

### Task 5: Build the add-course and bulk import flow

**Files:**
- Create: `src/features/import/AddCoursePage.tsx`, `src/features/import/AddCoursePage.module.css`, `src/features/import/AddCoursePage.test.tsx`
- Modify: `src/app/routes.tsx`
- Modify: `src/db/repositories.ts`

**Interfaces:**
- Consumes: `parsePlaylistId`, `YouTubePlaylistSource`, `YouTubeMetadataSource`, `CourseStore`, `normalizeTags`.
- Produces: add-course flow for one or multiple playlist URLs and `.txt` URL files; immediate core persistence followed by non-blocking best-effort metadata enrichment.

- [ ] **Step 1: Add a feature dependency container instead of importing global adapters inside UI**

Create `src/app/dependencies.ts`:

```ts
import { db } from '../db/database'
import { CourseStore } from '../db/repositories'
import { IframePlaylistSource } from '../youtube/iframePlaylistSource'
import { OEmbedMetadataSource } from '../youtube/metadata'

export const dependencies = {
  courseStore: new CourseStore(db),
  playlistSource: new IframePlaylistSource(),
  metadataSource: new OEmbedMetadataSource(),
}

export type AppDependencies = typeof dependencies
```

- [ ] **Step 2: Write a failing add-course component test with mocked dependencies**

Create `src/features/import/AddCoursePage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AddCoursePage } from './AddCoursePage'

it('discovers a pasted playlist, allows tags, and stores the course', async () => {
  const createCourse = vi.fn().mockResolvedValue(undefined)
  const getCourseByPlaylistId = vi.fn().mockResolvedValue(undefined)
  const deps = {
    playlistSource: { discover: vi.fn().mockResolvedValue({ playlistId: 'PL1', videoIds: ['v1', 'v2'] }) },
    metadataSource: {
      enrichPlaylist: vi.fn().mockResolvedValue({ playlistId: 'PL1', title: 'Rust Course' }),
      enrichVideo: vi.fn().mockResolvedValue({ videoId: 'v1', title: 'Intro', thumbnailUrl: 'thumb' }),
    },
    courseStore: { createCourse, getCourseByPlaylistId, listCourses: vi.fn().mockResolvedValue([]) },
  } as never

  render(<MemoryRouter><AddCoursePage deps={deps} /></MemoryRouter>)
  await userEvent.type(screen.getByLabelText(/playlist urls/i), 'https://www.youtube.com/playlist?list=PL1')
  await userEvent.click(screen.getByRole('button', { name: /discover/i }))
  expect(await screen.findByText(/2 lessons/i)).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText(/tags/i), 'Rust, Beginner')
  await userEvent.click(screen.getByRole('button', { name: /add course/i }))
  expect(createCourse).toHaveBeenCalledOnce()
})
```

- [ ] **Step 3: Run the component test and verify failure**

```bash
npm test -- src/features/import/AddCoursePage.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Implement URL batch parsing, discovery state, duplicate states, editable title, and tag entry**

In `AddCoursePage.tsx`, model each item with:

```ts
type ImportStatus = 'idle' | 'discovering' | 'ready' | 'duplicate' | 'error' | 'added'

interface ImportItem {
  rawUrl: string
  playlistId: string
  status: ImportStatus
  videoIds: string[]
  title: string
  titleSource: 'youtube' | 'user' | 'fallback'
  tags: string[]
  error?: string
}
```

Use `parsePlaylistId` on each non-empty line, dedupe playlist IDs within the batch, and independently call `deps.playlistSource.discover(playlistId)`. Before discovery, call `deps.courseStore.getCourseByPlaylistId(playlistId)` and render duplicate actions **Open existing course**, **Refresh existing course**, and **Skip** rather than creating a second course.

For valid new items, use fallback title `YouTube Playlist <first 8 chars of playlistId>` until metadata or user editing provides a better one. Start `metadataSource.enrichPlaylist(playlistId)` after discovery; if it returns a title before the user edits the field, use that title with `titleSource: 'youtube'`. Failure leaves the fallback and never blocks Add.

Load tag suggestions from `deps.courseStore.listCourses()`, flatten existing `course.tags`, pass them through `normalizeTags`, and render them through a `<datalist>` or accessible combobox attached to the tag-entry control. Selecting a suggestion appends it to the current course's tag chips rather than replacing prior tags.

- [ ] **Step 5: Persist the core course before metadata enrichment completes**

On **Add Course**, create:

```ts
const now = Date.now()
const courseId = crypto.randomUUID()
const course = {
  id: courseId,
  playlistId: item.playlistId,
  sourceUrl: item.rawUrl,
  title: item.title,
  titleSource: item.titleSource,
  tags: normalizeTags(item.tags),
  currentVideoId: item.videoIds[0],
  thumbnailVideoId: item.videoIds[0],
  createdAt: now,
  updatedAt: now,
  metadataUpdatedAt: now,
}
const videos = item.videoIds.map((videoId, position) => ({
  courseId, videoId, position, watched: false, resumeSeconds: 0,
  progressUpdatedAt: now, firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown' as const,
}))
await deps.courseStore.createCourse(course, videos)
```

After the transaction succeeds, enrich missing video metadata with a concurrency cap of 4. Implement a small local queue that starts at most four `enrichVideo` promises at once and writes each completed result with `courseStore.updateVideo`. The UI may navigate away while remaining enrichment promises finish; no course creation path may await all lesson metadata.

- [ ] **Step 6: Add `.txt` file import without adding backup parsing to this screen yet**

Add a file input accepting `.txt,.json`. For `.txt`, call `file.text()` and feed the contents through the exact same newline parser. For `.json`, inspect the top-level shape: if it contains `schemaVersion` and `courses`, navigate the user to `#/settings` with a message that backup restore is handled there; do not create a second backup-import implementation in this feature.

- [ ] **Step 7: Wire the route and style the four-step flow**

Replace the `/add` placeholder in `src/app/routes.tsx` with `<AddCoursePage deps={dependencies} />`. Use CSS Modules for the approved dark/purple layout, a mobile single-column flow, independent result cards in bulk mode, visible inline errors, and 44px touch targets.

- [ ] **Step 8: Verify add-course behavior**

```bash
npm test -- src/features/import/AddCoursePage.test.tsx src/youtube/urls.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/dependencies.ts src/app/routes.tsx src/features/import src/db/repositories.ts
git commit -m "feat: add playlist import flow"
```

---

### Task 6: Build the Continue Learning and searchable/tag-filtered library

**Files:**
- Create: `src/features/library/LibraryPage.tsx`, `src/features/library/LibraryPage.module.css`, `src/features/library/LibraryPage.test.tsx`
- Modify: `src/app/routes.tsx`

**Interfaces:**
- Consumes: `CourseStore.listCourses`, `CourseStore.getCourseVideos`, `calculateCourseProgress`, `selectContinueVideo`, `filterCourses`.
- Produces: home screen with up to four recently active incomplete courses, Continue navigation, full library search, AND tag filtering, status filter, and sorting.

- [ ] **Step 1: Write failing library UI tests**

Create `src/features/library/LibraryPage.test.tsx` with a fake store returning three courses and their videos. Assert:

```tsx
expect(await screen.findByRole('heading', { name: /continue learning/i })).toBeInTheDocument()
expect(screen.getAllByRole('button', { name: /continue/i })).toHaveLength(2)
await userEvent.type(screen.getByRole('searchbox'), 'rust')
expect(screen.getByText('Rust Course')).toBeInTheDocument()
expect(screen.queryByText('Statistics Course')).not.toBeInTheDocument()
```

Include a second test selecting two tag chips and assert that only a course containing both tags remains.

- [ ] **Step 2: Run the library tests and verify failure**

```bash
npm test -- src/features/library/LibraryPage.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement loading and derived progress summaries**

On mount, call `listCourses()`, then `Promise.all(courses.map(course => getCourseVideos(course.id)))`. Build a `Map<string, CourseProgressSummary>` with `calculateCourseProgress`. Build Continue Learning by filtering `active > 0 && percent < 100`, sorting on `lastOpenedAt ?? updatedAt` descending, and slicing to 4.

The **Continue** target is:

```ts
const video = selectContinueVideo(videosByCourseId.get(course.id) ?? [], course.currentVideoId)
navigate(`/course/${course.id}${video ? `?video=${encodeURIComponent(video.videoId)}` : ''}`)
```

- [ ] **Step 4: Implement search, filters, tags, status, and sort controls**

Keep UI state local:

```ts
const [query, setQuery] = useState('')
const [selectedTags, setSelectedTags] = useState<string[]>([])
const [status, setStatus] = useState<LibraryStatus>('all')
const [sort, setSort] = useState<LibrarySort>('recent')
```

Derive tag suggestions by flattening `courses.tags`, case-insensitively deduping them with `normalizeTags`, and sorting alphabetically for display. Call `filterCourses` for All Courses.

- [ ] **Step 5: Implement responsive library cards/rows**

Each Continue card must show title, thumbnail derived from `thumbnailVideoId`, tags, watched/active counts, percent bar, current lesson title when known, and **Continue**. All Courses rows show title, tags, progress, and an accessible action menu. Do not embed YouTube players on this page.

- [ ] **Step 6: Wire the library route and verify**

Replace the `/` placeholder with `<LibraryPage store={dependencies.courseStore} />`.

Run:

```bash
npm test -- src/features/library/LibraryPage.test.tsx src/domain/library.test.ts src/domain/tags.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/library src/app/routes.tsx
git commit -m "feat: add course library and continue learning"
```

---

### Task 7: Add the embedded player, course view, resume persistence, and watched controls

**Files:**
- Create: `src/youtube/playerAdapter.ts`
- Create: `src/features/course/YouTubePlayer.tsx`, `src/features/course/LessonList.tsx`
- Create: `src/features/course/CoursePage.tsx`, `src/features/course/CoursePage.module.css`, `src/features/course/CoursePage.test.tsx`
- Modify: `src/app/routes.tsx`, `src/db/repositories.ts`

**Interfaces:**
- Consumes: IFrame API, `CourseStore`, `shouldAutoComplete`, `selectContinueVideo`, `canonicalWatchUrl`.
- Produces: `PlayerAdapter` events, course route playback, 5-second resume writes, automatic/manual completion, current lesson updates, **Open on YouTube**, and **Next unwatched**.

- [ ] **Step 1: Define a testable player interface separate from React and YT globals**

Create `src/youtube/playerAdapter.ts`:

```ts
export type PlayerState = 'playing' | 'paused' | 'ended' | 'cued'
export interface PlayerSnapshot { videoId: string; currentTime: number; duration: number; state: PlayerState }
export interface PlayerAdapter {
  load(videoId: string, startSeconds: number): void
  snapshot(): PlayerSnapshot
  destroy(): void
}
```

`YouTubePlayer.tsx` will own the concrete `YT.Player`, but `CoursePage` receives player snapshots/events through callbacks so its progress logic can be tested without YouTube.

- [ ] **Step 2: Write failing course-page tests**

Create `src/features/course/CoursePage.test.tsx` with a fake store and render `CoursePage` inside `MemoryRouter` with initial route `/course/c1?video=v1`. Assert:

```tsx
expect(await screen.findByText('Lesson One')).toBeInTheDocument()
await userEvent.click(screen.getByRole('button', { name: /mark as watched/i }))
expect(updateProgress).toHaveBeenCalledWith('c1', 'v1', expect.objectContaining({ watched: true }))
await userEvent.click(screen.getByRole('button', { name: /next unwatched/i }))
expect(updateCourse).toHaveBeenCalledWith('c1', expect.objectContaining({ currentVideoId: 'v2' }))
```

Add a pure callback test that feeds `{ currentTime: 95, duration: 100, state: 'playing' }` and expects the persisted patch to contain `watched: true`.

- [ ] **Step 3: Run course tests and verify failure**

```bash
npm test -- src/features/course/CoursePage.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Implement `YouTubePlayer` and translate YouTube states/errors**

`YouTubePlayer` props:

```ts
interface YouTubePlayerProps {
  videoId: string
  startSeconds: number
  onSnapshot(snapshot: PlayerSnapshot): void
  onEmbedStatus(status: 'playable' | 'unavailable' | 'restricted'): void
}
```

On `onReady`, seek/load at `startSeconds`. On state changes, emit snapshots. Map common IFrame errors so `101`/`150` become `restricted`, removed/private/unavailable errors become `unavailable`, and successful playback becomes `playable`. Always destroy the player on component unmount.

- [ ] **Step 5: Implement debounced/periodic progress persistence in `CoursePage`**

Keep the latest player snapshot in a ref. While state is `playing`, start one interval at 5,000 ms that calls:

```ts
await store.updateProgress(course.id, current.videoId, {
  watched: current.watched || shouldAutoComplete({
    currentTime: snapshot.currentTime,
    duration: snapshot.duration,
    ended: snapshot.state === 'ended',
  }),
  resumeSeconds: Math.max(0, snapshot.currentTime),
  progressUpdatedAt: Date.now(),
})
```

Flush the latest snapshot on pause/ended, before loading another lesson, on `visibilitychange` when `document.visibilityState === 'hidden'`, and in the course-page cleanup path. Replaying a watched lesson keeps `watched: true` unless the user explicitly selects **Mark unwatched**.

- [ ] **Step 6: Persist current course activity and duration/embed metadata**

When a lesson is selected, update:

```ts
await store.updateCourse(course.id, {
  currentVideoId: videoId,
  lastOpenedAt: Date.now(),
  updatedAt: Date.now(),
})
```

When a valid player duration is learned, call `updateVideo` with `durationSeconds`. When embed status is learned, store it. If a video is restricted/unavailable, keep the lesson visible, show the supplied error copy, and expose **Open on YouTube** plus manual watched controls.

- [ ] **Step 7: Implement `LessonList` and responsive course layout**

Phone `<768px`: header → 16:9 player → actions → collapsible list. Desktop `>=1024px`: player/actions on left and scrollable lesson list on right. Current lesson gets an active style; watched rows show a checked indicator; removed rows are excluded by default.

- [ ] **Step 8: Wire the course route and verify**

Replace `/course/:courseId` with `<CoursePage store={dependencies.courseStore} />`.

Run:

```bash
npm test -- src/features/course/CoursePage.test.tsx src/domain/progress.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/youtube/playerAdapter.ts src/features/course src/app/routes.tsx src/db/repositories.ts
git commit -m "feat: add course playback and progress tracking"
```

---

### Task 8: Add explicit playlist refresh with progress preservation

**Files:**
- Modify: `src/features/course/CoursePage.tsx`, `src/features/course/CoursePage.test.tsx`
- Modify: `src/db/repositories.ts`

**Interfaces:**
- Consumes: `YouTubePlaylistSource.discover`, `diffPlaylist`, `CourseStore.replaceCourseVideos`, `YouTubeMetadataSource`.
- Produces: explicit **Refresh playlist**, summary `added · removed · unchanged`, removed-history toggle, and preservation/reactivation semantics.

- [ ] **Step 1: Write the failing refresh integration test**

Add to `CoursePage.test.tsx` a fake playlist source returning `['v2', 'v1', 'v3']` when stored videos are `v1`, `v2`, `old`. Seed `v1` watched/resume state. Click **Refresh playlist** and assert:

```tsx
expect(await screen.findByText(/1 added · 1 removed · 2 unchanged/i)).toBeInTheDocument()
expect(replaceCourseVideos).toHaveBeenCalledWith('c1', expect.arrayContaining([
  expect.objectContaining({ videoId: 'v1', watched: true }),
  expect.objectContaining({ videoId: 'old', removedAt: expect.any(Number) }),
  expect.objectContaining({ videoId: 'v3', watched: false }),
]))
```

- [ ] **Step 2: Run the refresh test and verify failure**

```bash
npm test -- src/features/course/CoursePage.test.tsx
```

Expected: FAIL on the missing refresh control.

- [ ] **Step 3: Implement refresh orchestration**

Inject `playlistSource` and `metadataSource` into `CoursePage`. On explicit click:

```ts
const discovery = await playlistSource.discover(course.playlistId)
const now = Date.now()
const diff = diffPlaylist(videos, discovery.videoIds, now)
await store.replaceCourseVideos(course.id, diff.videos.map((video) => ({ ...video, courseId: course.id })))
await store.updateCourse(course.id, { lastRefreshedAt: now, updatedAt: now })
setRefreshSummary(diff.summary)
```

Only after the transaction succeeds, start best-effort enrichment for new/missing video records. Keep refresh disabled while discovery/persistence is active to prevent duplicate concurrent refreshes.

- [ ] **Step 4: Add removed-history visibility and recovery UI**

Default list = videos where `removedAt === undefined`. When historical removed records exist, render a **Show removed lessons** checkbox/button using:

```ts
const visibleVideos = showRemoved ? videos : videos.filter((video) => video.removedAt === undefined)
```

Removed rows must remain read-only for playlist position but still allow the user to inspect prior watched/resume data and open the video on YouTube if desired.

- [ ] **Step 5: Verify refresh behavior**

```bash
npm test -- src/domain/refresh.test.ts src/features/course/CoursePage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/course src/db/repositories.ts
git commit -m "feat: add manual playlist refresh"
```

---

### Task 9: Implement versioned backup, merge/replace, native share, and single-course export

**Files:**
- Create: `src/db/backup.ts`, `src/db/backup.test.ts`
- Create: `src/features/settings/SettingsPage.tsx`, `src/features/settings/SettingsPage.module.css`, `src/features/settings/SettingsPage.test.tsx`
- Modify: `src/app/routes.tsx`, `src/db/repositories.ts`

**Interfaces:**
- Consumes: Dexie tables/transactions, course merge identity rules.
- Produces: `BackupV1`, `createBackup`, `parseAndMigrateBackup`, `mergeBackup`, `replaceWithBackup`, file download/native share, preview-before-mutation.

- [ ] **Step 1: Define a portable backup shape that does not depend on local Dexie course IDs**

In `src/db/backup.ts` define:

```ts
export interface BackupVideoV1 {
  videoId: string
  position: number
  title?: string
  authorName?: string
  thumbnailUrl?: string
  durationSeconds?: number
  watched: boolean
  resumeSeconds: number
  progressUpdatedAt: number
  firstSeenAt: number
  lastSeenAt: number
  removedAt?: number
  embedStatus: 'unknown' | 'playable' | 'unavailable' | 'restricted'
}

export interface BackupCourseV1 {
  playlistId: string
  sourceUrl: string
  title: string
  titleSource: 'youtube' | 'user' | 'fallback'
  authorName?: string
  thumbnailVideoId?: string
  tags: string[]
  currentVideoId?: string
  createdAt: number
  updatedAt: number
  metadataUpdatedAt: number
  lastOpenedAt?: number
  lastRefreshedAt?: number
  videos: BackupVideoV1[]
}

export interface BackupV1 {
  schemaVersion: 1
  exportedAt: string
  courses: BackupCourseV1[]
}
```

Local `course.id` and each video `courseId` are intentionally omitted; merge identity is the YouTube playlist/video pair from the approved spec.

- [ ] **Step 2: Write failing backup validation and merge tests**

Create `src/db/backup.test.ts` covering:

1. schema version 1 parses successfully;
2. unsupported versions reject before mutation;
3. newer `progressUpdatedAt` wins watched/resume;
4. newer course `metadataUpdatedAt` wins title/tags;
5. an imported unknown playlist gets a fresh local UUID;
6. replace runs atomically.

Representative merge assertion:

```ts
expect(mergedVideo).toMatchObject({ watched: true, resumeSeconds: 88, progressUpdatedAt: 500 })
expect(mergedCourse).toMatchObject({ title: 'New local title', tags: ['Rust'], metadataUpdatedAt: 600 })
```

- [ ] **Step 3: Run backup tests and verify failure**

```bash
npm test -- src/db/backup.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement Zod validation and a migration entrypoint**

Use a discriminated schema with `schemaVersion: z.literal(1)`. Implement:

```ts
export function parseAndMigrateBackup(input: unknown): BackupV1 {
  return backupV1Schema.parse(input)
}
```

The function name deliberately includes migration now so version 2 can later parse old versions through migrations without changing UI callers. Unsupported versions must produce a user-displayable validation error before any IndexedDB transaction starts.

- [ ] **Step 5: Implement backup creation and merge/replace in one Dexie transaction**

`createBackup(store, courseId?)` loads one or all courses and videos and produces `BackupV1`.

For merge, load local courses by `playlistId`. Existing course: keep local `id`; choose incoming vs local title/tags from the newer `metadataUpdatedAt`; merge each video by `videoId` and choose watched/resume fields from the newer `progressUpdatedAt`. New playlist: generate `crypto.randomUUID()` and remap every imported video to that new local `courseId`.

For replace, validate first, then in one `rw` transaction clear course/video data and insert newly remapped local IDs. A validation failure or transaction exception leaves the pre-import library unchanged.

- [ ] **Step 6: Write the failing Settings UI test**

Create `src/features/settings/SettingsPage.test.tsx` and verify that selecting a valid backup file renders a preview such as `2 courses · 75 lessons` before either **Merge** or **Replace local library** becomes actionable. Verify replace requires a destructive confirmation.

- [ ] **Step 7: Implement export/download/share behavior**

Create a JSON `File`:

```ts
const file = new File(
  [JSON.stringify(backup, null, 2)],
  `course-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`,
  { type: 'application/json' },
)
```

If `navigator.canShare?.({ files: [file] })` is true, show **Share to another device** and call `navigator.share({ files: [file], title: 'CourseTracker backup' })`. Always retain **Download backup** as a fallback by creating an object URL and a temporary `<a download>`.

Add **Export this course** from the course action menu using the same file format with one `courses` entry.

- [ ] **Step 8: Wire Settings route and verify**

Replace `/settings` placeholder with `<SettingsPage store={dependencies.courseStore} />`.

Run:

```bash
npm test -- src/db/backup.test.ts src/features/settings/SettingsPage.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/backup.ts src/db/backup.test.ts src/features/settings src/app/routes.tsx src/db/repositories.ts src/features/course
git commit -m "feat: add portable library backup and restore"
```

---

### Task 10: Finish resilient error states, metadata retry, and accessibility/responsive polish

**Files:**
- Modify: `src/app/App.tsx`, `src/styles/tokens.css`, `src/styles/globals.css`
- Modify: `src/features/import/*`, `src/features/library/*`, `src/features/course/*`, `src/features/settings/*`
- Create: `src/app/StorageGate.tsx`, `src/app/StorageGate.test.tsx`

**Interfaces:**
- Consumes: existing feature surfaces.
- Produces: blocking IndexedDB-unavailable state, local/recoverable network errors, keyboard/touch accessibility, final mobile/desktop responsive behavior.

- [ ] **Step 1: Write the failing IndexedDB availability test**

Create `src/app/StorageGate.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StorageGate } from './StorageGate'

it('blocks the application when IndexedDB is unavailable', async () => {
  render(<StorageGate check={async () => false}><div>Private app</div></StorageGate>)
  expect(await screen.findByRole('heading', { name: /local storage is required/i })).toBeInTheDocument()
  expect(screen.queryByText('Private app')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Implement the storage gate and wrap the app routes**

`StorageGate` takes an injectable `check(): Promise<boolean>`. Implement the production probe without touching the real CourseTracker database:

```ts
export async function checkIndexedDb(): Promise<boolean> {
  if (!('indexedDB' in window)) return false
  const name = `course-tracker-probe-${crypto.randomUUID()}`
  return await new Promise<boolean>((resolve) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('probe')
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('probe', 'readwrite')
      tx.objectStore('probe').put('ok', 'key')
      tx.oncomplete = () => { db.close(); indexedDB.deleteDatabase(name); resolve(true) }
      tx.onerror = () => { db.close(); indexedDB.deleteDatabase(name); resolve(false) }
    }
  })
}
```

On failure show `CourseTracker needs IndexedDB to save your courses and progress. This browser or browsing mode is not providing persistent local storage.` Do not mount feature routes behind this error state.

- [ ] **Step 3: Apply the approved local error copy and retry actions**

Use these exact behaviors:

- Invalid URL: `This does not look like a YouTube playlist URL.`
- Playlist discovery: `CourseTracker couldn't read this playlist from YouTube. Check that the playlist is accessible and try again.` with **Retry**, **Open playlist on YouTube**, **Remove from batch**.
- Metadata failure: non-blocking placeholder with **Retry lesson details**; core Add remains enabled.
- Embed failure: `This lesson can't be played in an embedded player.` with **Open on YouTube** and manual watched controls.
- Backup validation: show schema/validation message and perform no mutation.

In Settings/About add concise privacy/network copy: `Your courses, tags, progress, and resume positions stay in this browser until you export them. CourseTracker has no server. Your browser still contacts YouTube for playlist discovery, embedded playback, thumbnails, and optional lesson metadata.`

- [ ] **Step 4: Audit touch and keyboard behavior with tests**

Add Testing Library assertions that every icon-only button has an accessible name, lesson rows can be activated with buttons/links rather than click-only `<div>` handlers, the mobile lesson disclosure uses a real `<button aria-expanded>`, and destructive replace has an explicit confirmation control. Representative assertions:

```tsx
expect(screen.getByRole('button', { name: /course actions/i })).toBeVisible()
expect(screen.getByRole('button', { name: /course content/i })).toHaveAttribute('aria-expanded')
expect(screen.getByRole('button', { name: /replace local library/i })).toBeDisabled()
await userEvent.click(screen.getByRole('checkbox', { name: /i understand this replaces/i }))
expect(screen.getByRole('button', { name: /replace local library/i })).toBeEnabled()
```

- [ ] **Step 5: Complete responsive styles**

Verify CSS modules implement:

```css
/* default: phone */
.courseLayout { display: grid; gap: 1rem; }
.playerFrame { aspect-ratio: 16 / 9; width: 100%; }

@media (min-width: 768px) {
  .libraryGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (min-width: 1024px) {
  .courseLayout { grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr); align-items: start; }
  .lessonPanel { max-height: calc(100vh - 10rem); overflow: auto; }
}
```

Keep primary actions at least 44px high and never rely on hover to reveal required controls.

- [ ] **Step 6: Run the full unit/integration test suite and build**

```bash
npm test
npm run build
```

Expected: PASS with no console errors from React tests.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat: harden responsive and accessible UX"
```

---

### Task 11: Add deterministic E2E coverage, GitHub Pages deployment, and real-YouTube smoke instructions

**Files:**
- Create: `e2e/add-course.spec.ts`, `e2e/course-progress.spec.ts`, `e2e/refresh.spec.ts`, `e2e/backup.spec.ts`, `e2e/mobile.spec.ts`
- Create/modify: `playwright.config.ts`
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete application.
- Produces: deterministic browser regression suite, static Pages deployment workflow, and one documented manual smoke check against real YouTube.

- [ ] **Step 1: Add a deterministic browser-only YouTube mock hook**

Before app bootstrap in Playwright, inject a `window.__COURSETRACKER_TEST_ADAPTER__` object only when `import.meta.env.MODE === 'test'` or a dedicated E2E query flag is present. The app dependency factory may consume this adapter instead of live IFrame/oEmbed implementations. Do not ship hard-coded playlist fixtures in the normal production path.

The mock fixture must define `PL_RUST` with `['rust-1', 'rust-2', 'rust-3']`, titles, durations, and controllable refresh result `['rust-2', 'rust-1', 'rust-4']`.

- [ ] **Step 2: Configure Playwright against Vite preview**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
})
```

- [ ] **Step 3: Write the add-course E2E test**

`e2e/add-course.spec.ts` must:

1. open `/#/add?e2e=1`;
2. paste `https://www.youtube.com/playlist?list=PL_RUST`;
3. discover 3 lessons;
4. add tags `Rust` and `Beginner`;
5. add the course;
6. return to home and assert the course appears with `0 / 3` progress.

- [ ] **Step 4: Write progress/continue E2E coverage**

`e2e/course-progress.spec.ts` must open the imported course, use the fake player control to advance the first lesson to 95%, assert it becomes watched, set second lesson resume to 42 seconds, navigate home, click **Continue**, and assert lesson 2 is current with the 42-second resume supplied to the player adapter.

- [ ] **Step 5: Write refresh E2E coverage**

`e2e/refresh.spec.ts` must seed watched/resume state, trigger refresh, assert `1 added · 1 removed · 2 unchanged`, verify reordered `rust-1` retains progress, and verify **Show removed lessons** reveals `rust-3`.

- [ ] **Step 6: Write backup/restore E2E coverage**

`e2e/backup.spec.ts` exports a backup, clears the local IndexedDB via browser context, imports the captured JSON, previews it, merges it, and asserts tags/progress/resume are restored.

- [ ] **Step 7: Write the mobile-flow E2E test**

`e2e/mobile.spec.ts` uses the Pixel 7 project and asserts the player is above the collapsible lesson list, the disclosure button is reachable, and core actions fit without horizontal scrolling. Also assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.

- [ ] **Step 8: Run E2E locally and fix only deterministic failures**

```bash
npm run e2e
```

Expected: all desktop/mobile mock-adapter tests PASS without live YouTube/network dependency.

- [ ] **Step 9: Add GitHub Pages deployment workflow**

Create `.github/workflows/deploy-pages.yml`:

```yaml
name: Deploy GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test
      - run: npm run e2e -- --project=chromium
      - run: npm run build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 10: Document the one real-YouTube manual smoke test**

Add to `README.md`:

```md
## Real YouTube smoke test

Automated CI mocks YouTube to stay deterministic. Before a release:

1. Run `npm run dev` in a normal browser session with network access.
2. Add one public YouTube playlist using its real playlist URL.
3. Confirm discovery returns an ordered lesson list without an API key.
4. Open one embeddable lesson and confirm playback starts.
5. Seek beyond 95%, leave the course, return, and confirm watched/resume state persisted.
6. Click Refresh playlist and confirm the refresh completes without losing existing progress.
7. Open one lesson on YouTube and confirm the generated URL contains both `v=` and `list=`.

A metadata/oEmbed failure is acceptable if video IDs, playback/open-on-YouTube, and progress tracking still work.
```

- [ ] **Step 11: Run the release gate**

```bash
npm run check
```

Expected: unit/integration tests PASS, production build PASS, Playwright desktop/mobile tests PASS.

- [ ] **Step 12: Commit**

```bash
git add e2e playwright.config.ts .github/workflows/deploy-pages.yml README.md
git commit -m "ci: verify and deploy CourseTracker to Pages"
```

---

## Final Acceptance Checklist

Before calling v1 complete, verify all of the following in the built application:

- [ ] A new browser can add one or several playlist URLs without a backend/API key.
- [ ] One invalid playlist in a bulk import does not block valid playlists.
- [ ] Duplicate playlist IDs offer Open / Refresh / Skip rather than creating duplicates.
- [ ] Core course creation works when all optional metadata requests fail.
- [ ] Embedded playback, Open on YouTube, watched/unwatched correction, 95% auto-completion, and Next unwatched work.
- [ ] Resume time survives route changes/reloads and is persisted approximately every 5 seconds while playing.
- [ ] Continue Learning shows at most four recent incomplete courses and resumes the correct lesson.
- [ ] Search, status, sort, and AND multi-tag filtering work.
- [ ] Explicit refresh preserves progress, marks missing IDs removed, handles reorder, and reactivates returning IDs.
- [ ] Export/import uses a versioned JSON format; merge/replace is previewed and transactional.
- [ ] Native file share appears only when supported, with download always available as fallback.
- [ ] Removed/private/embed-restricted videos do not break a course.
- [ ] IndexedDB failure blocks the app with a clear explanation.
- [ ] Settings/About accurately explains local storage and the network requests sent to YouTube.
- [ ] Phone layout is player-first/collapsible; desktop layout is two-column at `>=1024px`.
- [ ] All required controls work by keyboard/touch and use approximately 44px touch targets.
- [ ] GitHub Pages can load assets from a repository subpath and direct app navigation uses hash routes.
- [ ] No v1 code adds notes, ratings, favorites, accounts, background sync, or other deferred features.
