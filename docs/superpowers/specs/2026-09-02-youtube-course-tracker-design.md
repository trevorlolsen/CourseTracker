# YouTube Course Tracker — v1 Design

Date: 2026-09-02
Status: Approved product direction; ready for user spec review
Working title: CourseTracker

## 1. Product Goal

Build a mobile-friendly static web application for treating YouTube playlists as self-paced courses. The application has no backend, no user accounts, no API keys, and no server-side operations. It is suitable for GitHub Pages hosting and stores all durable application state in IndexedDB.

The app solves one primary problem: a user is learning from several YouTube playlists at the same time and wants a fast way to resume each course, see progress, and organize courses by topic.

### Core mental model

- One YouTube playlist equals one course.
- YouTube owns the playlist contents and ordering.
- CourseTracker owns local progress, resume state, tags, and local organization.
- Playlist contents change only when the user explicitly chooses **Refresh playlist**.
- The app is local-first. Export/import is the portability mechanism between devices.

## 2. v1 Scope

### In scope

- Add one or many YouTube playlist URLs.
- Import playlist URLs from a plain-text file.
- Import a CourseTracker backup file.
- Discover the ordered video IDs in a playlist without a YouTube Data API key.
- Generate canonical YouTube watch links for every discovered lesson.
- Watch videos inside the app with the YouTube IFrame Player API.
- Open any lesson directly on YouTube.
- Track watched/unwatched state per lesson.
- Automatically mark a lesson watched when it reaches 95% or receives the YouTube `ENDED` event.
- Allow manual **Mark watched** / **Mark unwatched** correction.
- Save resume position while watching.
- Track course completion percentage.
- Maintain a "current lesson" for each course.
- Show a **Continue Learning** section for recently active courses.
- Maintain a full searchable course library.
- Assign multiple tags to each course.
- Filter the library by one or more tags.
- Manually refresh a playlist while preserving existing progress by video ID.
- Export the local library to a portable versioned JSON backup.
- Share that backup with the native Web Share API when available; otherwise download it.
- Import/merge a backup on another device.
- Responsive phone and desktop course-player layouts.

### Explicitly out of scope for v1

- Server-side storage or synchronization.
- User accounts or authentication.
- YouTube Data API keys.
- Editing YouTube playlists inside CourseTracker.
- Combining multiple YouTube playlists into one course.
- Arbitrary single-video courses.
- Notes, ratings, favorites, comments, or social features.
- Automatic playlist refresh.
- Background synchronization.
- True real-time cross-device sync.
- Full YouTube watch-history integration.
- Browser extension functionality.
- Native mobile apps.
- Offline video playback.

## 3. User Experience

## 3.1 Home / Library

The home screen is optimized for quickly resuming active learning while still making the whole library easy to browse.

### Continue Learning

At the top, show up to 4 recently active, incomplete courses.

Each card shows:

- course title
- thumbnail
- tags
- watched count / active lesson count
- completion percentage and progress bar
- current lesson title when available
- primary **Continue** button

**Continue** opens the course at its current lesson and stored resume time. If the stored current lesson is already watched, the app advances to the next unwatched lesson when possible.

### All Courses

Below Continue Learning, show all courses in a compact list/card view.

Controls:

- search by course title, channel/author when known, and tags
- multi-tag filtering
- status filter: All / In progress / Completed
- sort: Recently active (default), Title, Progress

A course row shows its progress and a compact action menu.

## 3.2 Add Course Flow

Primary action: **+ Add**.

The add screen supports three input paths:

1. Paste one playlist URL.
2. Paste multiple playlist URLs, one per line.
3. Import a `.txt`, `.json`, or CourseTracker backup file.

For normal playlist URLs the flow is:

1. **Paste** — normalize URLs and extract playlist IDs.
2. **Discover** — load the playlist through a hidden/non-primary YouTube IFrame player and obtain the ordered video IDs.
3. **Preview** — show playlist/course information, discovered lesson count, metadata enrichment status, and any warnings.
4. **Add** — optionally edit the local course title and assign tags, then store it.

Bulk import shows one result card per playlist with success/failure independently. One bad playlist must not block valid playlists.

### Duplicate handling

If a playlist ID is already present, do not silently duplicate it. Show:

- **Open existing course**
- **Refresh existing course**
- **Skip**

## 3.3 Course View

### Phone

Player-first layout:

1. compact course header
2. 16:9 embedded player
3. playback/progress actions
4. collapsible course-content list

The lesson list remains easy to reach with one thumb. The current lesson is visually highlighted.

### Desktop/tablet

Two-column layout:

- left: player and primary actions
- right: scrollable lesson list

The lesson list should remain visible while the user watches.

### Lesson row

Each lesson row shows:

- playlist position
- lesson title when known; otherwise `Video <short-id>` / loading placeholder
- duration when learned from playback; optional rather than required
- watched indicator
- current/resume indicator
- unavailable/removed status when applicable

Tapping a lesson loads it into the embedded player.

Primary player actions:

- Mark watched / Mark unwatched
- Open on YouTube
- Next unwatched

The generated YouTube link should include both `v=<videoId>` and `list=<playlistId>` so opening YouTube keeps the playlist context.

## 3.4 Progress Behavior

### Automatic completion

A lesson becomes watched when either:

- the YouTube player emits `ENDED`, or
- `currentTime / duration >= 0.95` while valid duration data is available.

Manual watched/unwatched changes always override the automatic result at the time the user makes the change.

### Resume position

While a video is playing, persist its current position periodically (approximately every 5 seconds), and also on:

- pause
- video change
- page visibility change
- navigation away from the course

For resilience, store resume position per course-video rather than only in memory for the single current lesson. This costs very little storage and prevents accidental loss if the user jumps among lessons. `currentVideoId` on the course still defines the lesson used by **Continue**.

When a watched video is intentionally replayed, do not automatically mark it unwatched.

### Course completion

Completion percentage is:

`watched active lessons / active lessons`

Lessons removed from the YouTube playlist are excluded from the active denominator but their historical progress remains stored.

## 3.5 Tags

A course can have zero or more tags.

Tag behavior:

- free-form text
- case-insensitive uniqueness (`Rust` and `rust` are one tag)
- preserve a display casing from the most recent edit
- autocomplete from tags already used in the library
- allow multiple selected tag filters

Filtering semantics for multiple tags: **AND** by default. A course must contain every selected tag. This makes combinations such as `Rust + Beginner` useful and predictable.

## 3.6 Manual Playlist Refresh

Refreshing is always explicit.

Flow:

1. User selects **Refresh playlist**.
2. App rediscovers the current ordered video-ID list from YouTube.
3. App diffs that list against the stored active list.
4. Existing IDs preserve progress and resume state.
5. New IDs are inserted as unwatched in the current YouTube order.
6. IDs no longer present become `removed` rather than being deleted.
7. Reordered IDs receive their new positions without changing progress.
8. Metadata enrichment is attempted only where needed.
9. Show a result summary, e.g. `3 added · 1 removed · 42 unchanged`.

Removed lessons are hidden by default. A small **Show removed lessons** option exposes them for history/debugging.

If a removed video later reappears, reactivate the existing record and preserve its prior progress.

## 4. YouTube Integration Without API Keys

## 4.1 Playlist discovery

Use the official YouTube IFrame Player API.

For a parsed playlist ID:

- create/cue a player with `listType: 'playlist'` and `list: <playlistId>`
- wait for the player to become ready/cued
- call `player.getPlaylist()`
- store the returned ordered array of video IDs

Playlist discovery must be wrapped behind a small `YouTubePlaylistSource` interface so YouTube-specific behavior is isolated from the rest of the application.

Core functionality must depend only on video IDs, not metadata.

## 4.2 Metadata enrichment

For user-friendly titles and thumbnails, use best-effort enrichment after IDs are discovered.

Preferred path:

- YouTube oEmbed for public video/playlist metadata when direct browser access succeeds
- deterministic thumbnail URL derived from the video ID when needed

Metadata is optional. The app must remain fully usable if metadata cannot be retrieved because of CORS, privacy restrictions, removed/private videos, network failures, or future YouTube changes.

Enrichment rules:

- limit parallel metadata requests (e.g. 4 at a time)
- cache results in IndexedDB
- do not repeatedly fetch metadata that is already present
- on refresh, enrich only new/missing records unless user explicitly retries

The preview screen should say `Loading lesson details…` while enrichment proceeds, but **Add Course** should not require all enrichment to finish.

## 4.3 Embed failures

The IFrame API can report removed/private videos or videos whose owners disallow embedding.

For an unplayable embedded lesson:

- retain it in the course
- show a clear unavailable/embed-restricted state
- offer **Open on YouTube**
- allow manual Mark watched / Mark unwatched

A single bad video must not break course playback or refresh.

## 5. Local Persistence

Use IndexedDB through a small repository layer. Dexie is recommended for implementation because it gives schema versioning, transactions, indexed queries, and clean TypeScript ergonomics while still compiling to a fully static client application.

### Database: `course-tracker`

### `courses`

Primary key: `id` (UUID)

Fields:

- `id`
- `playlistId` — unique logical identity
- `sourceUrl`
- `title`
- `titleSource` — `youtube | user | fallback`
- `authorName?`
- `thumbnailVideoId?`
- `tags: string[]`
- `currentVideoId?`
- `createdAt`
- `updatedAt`
- `metadataUpdatedAt`
- `lastOpenedAt?`
- `lastRefreshedAt?`

Indexes needed for playlist ID and recent activity.

### `courseVideos`

Logical key: `[courseId, videoId]`

Fields:

- `courseId`
- `videoId`
- `position`
- `title?`
- `authorName?`
- `thumbnailUrl?`
- `durationSeconds?`
- `watched`
- `resumeSeconds`
- `progressUpdatedAt`
- `firstSeenAt`
- `lastSeenAt`
- `removedAt?`
- `embedStatus` — `unknown | playable | unavailable | restricted`

If the same video occurs more than once in a YouTube playlist, v1 treats progress as belonging to the video within that course, so duplicate occurrences share watched/resume state. Their first playlist occurrence is used in the normal lesson list; duplicate occurrences may be indicated in refresh diagnostics rather than modeled as independent learning progress.

### `settings`

Key/value records for:

- database/app schema version
- completion threshold (internally fixed to 0.95 for v1, but stored/migratable if useful)
- future client settings

Do not create a separate tags table in v1; derive tag suggestions from `courses.tags`.

## 6. Backup and Device Transfer

Because there is no backend, device transfer is deliberately file-based but optimized to feel lightweight.

### Export

**Settings → Export Library** creates a versioned JSON file containing:

- schema version
- export timestamp
- courses
- course-video metadata
- progress and resume data
- tags

Do not export caches that can be regenerated unless they meaningfully improve import UX.

Filename example:

`course-tracker-backup-2026-09-02.json`

On browsers supporting the Web Share API with files, offer **Share to another device**. This lets mobile users use AirDrop, Nearby Share/Quick Share, Messages, email, cloud-drive apps, etc. without CourseTracker operating a server.

Fallback: normal file download.

Also allow exporting a single course for smaller transfers.

### Import / merge

On importing a backup, show a preview before mutation.

Default action: **Merge**.

Identity rules:

- courses merge by `playlistId`
- lesson progress merges by `(playlistId, videoId)`
- newest `progressUpdatedAt` wins for watched/resume state
- newest course `metadataUpdatedAt` wins for local title/tags
- unknown/new courses are added

Alternative action: **Replace local library**, behind a destructive confirmation.

The file format must include a schema version and use migration functions when the format evolves.

### Why no QR-only full-library transfer in v1

A QR code is convenient but has limited payload capacity, while a library with hundreds of lessons can be too large. A native-share JSON file is more dependable and works with the static/no-server requirement. QR transfer can be explored later for a single course or small compressed payload.

## 7. Architecture

Recommended stack:

- React
- TypeScript
- Vite
- Dexie for IndexedDB
- CSS Modules or a small utility-first CSS setup; avoid a heavy component framework
- Vitest for unit/integration tests
- Playwright for end-to-end tests

### Main modules

#### `youtube/`

Owns all YouTube-specific behavior.

- URL parsing and normalization
- playlist discovery wrapper around IFrame API
- player wrapper/events
- oEmbed metadata enrichment
- generated YouTube links

No IndexedDB logic.

#### `db/`

Owns persistence and migrations.

- Dexie schema
- course repository
- course-video repository
- backup export/import

No direct YouTube calls.

#### `domain/`

Pure business rules.

- progress calculation
- continue-course selection
- playlist refresh diff
- merge conflict rules
- tag normalization/filtering

No DOM, YouTube, or IndexedDB dependencies.

#### `features/library/`

Home screen, Continue Learning, search, filters, tags.

#### `features/import/`

Paste/bulk/file import, discovery preview, add flow.

#### `features/course/`

Course/player screen, lesson list, progress updates, manual refresh.

#### `features/settings/`

Backup/share/import and basic local application information.

This separation allows YouTube behavior, persistence, and business rules to be tested independently.

## 8. Routing and GitHub Pages

The application must deploy as static assets.

Use hash-based routing for v1 so direct navigation works reliably on GitHub Pages without a custom 404 rewrite strategy.

Suggested routes:

- `#/` — library
- `#/course/<courseId>` — course view
- `#/add` — import flow
- `#/settings` — backup/restore

Set Vite's base path correctly for repository-based GitHub Pages deployments.

No server-rendered route is required.

## 9. Responsive and Visual Design

Use the approved dark CourseTracker direction:

- near-black/navy surfaces
- purple accent for primary actions and active progress
- high-contrast white/gray text
- rounded but compact cards
- strong progress visualization
- minimal chrome around the actual course content

### Breakpoints

Mobile-first CSS.

- `< 768px`: player-first stacked course view
- `>= 768px`: progressively wider cards and filters
- `>= 1024px`: two-column player + lesson list

Avoid hover-only interactions. Every action must work by touch and keyboard.

Minimum touch target: approximately 44px.

Respect `prefers-reduced-motion`.

## 10. Error Handling

Errors should be local and recoverable wherever possible.

Examples:

### Invalid URL

`This does not look like a YouTube playlist URL.`

### Playlist discovery failed

`CourseTracker couldn't read this playlist from YouTube. Check that the playlist is accessible and try again.`

Actions: Retry / Open playlist on YouTube / Remove from batch.

### Metadata unavailable

Not a blocking error. Use placeholders and allow retry later.

### Embed restricted

`This lesson can't be played in an embedded player.`

Action: Open on YouTube.

### IndexedDB unavailable

Show a blocking explanation that local storage is required. Do not silently fall back to transient in-memory state.

### Import failure

Validate the whole backup before mutating IndexedDB. Use a transaction so partial imports do not corrupt the library.

## 11. Testing Strategy

### Unit tests

High coverage for pure rules:

- YouTube URL parsing
- playlist ID extraction
- canonical link generation
- completion calculations
- 95% auto-complete rule
- Continue selection
- tag normalization and AND filtering
- playlist refresh diff
- reappearance of removed videos
- backup merge conflict rules
- backup schema validation/migration

### Integration tests

- IndexedDB repository behavior using a browser-compatible test environment
- import transaction rollback
- course refresh persistence
- progress updates from a mocked player adapter

### E2E tests

Use Playwright with the YouTube adapter mocked for deterministic CI tests:

1. add a playlist
2. preview and tag it
3. open course
4. watch/update progress
5. continue from home
6. manually mark watched/unwatched
7. refresh with added/removed/reordered videos
8. search/filter tags
9. export and import/merge library
10. narrow mobile viewport flow

Keep one optional/manual smoke test against a real public YouTube playlist because network/player behavior should not make normal CI flaky.

## 12. Performance

The expected library is small enough for IndexedDB and normal React rendering, but playlists can contain many videos.

Requirements:

- do not block course creation on all metadata requests
- bound metadata concurrency
- persist metadata incrementally
- virtualize the lesson list only if real testing shows a need; do not add it preemptively
- avoid loading multiple visible YouTube players simultaneously on the home screen
- destroy hidden player instances after discovery

## 13. Privacy and Network Behavior

All course organization and learning progress remains in the browser's IndexedDB until the user explicitly exports it.

There is no CourseTracker server.

The browser will contact YouTube for:

- IFrame Player API script/player content
- playlist/video playback
- playlist discovery through the embedded player
- optional oEmbed metadata enrichment
- thumbnails

The app should state this plainly in Settings/About rather than claiming to be fully offline or network-private.

## 14. Definition of Done for v1

v1 is successful when a user can:

1. Open the static app from GitHub Pages on desktop or phone.
2. Paste one or several accessible YouTube playlist URLs.
3. Add each playlist as a local course without any API key.
4. Assign tags.
5. Watch lessons in the embedded player or open them on YouTube.
6. Leave and later resume the current course/video near the saved position.
7. See accurate watched counts and course completion.
8. Correct watched state manually.
9. Jump rapidly among several active courses from Continue Learning.
10. Find courses by search and combined tags.
11. Manually refresh a playlist and preserve existing progress.
12. Export the local library and share/import it on another device.
13. Recover gracefully when a YouTube video is removed, private, or not embeddable.
14. Use the core flows comfortably on a phone-sized screen.

## 15. Deferred Ideas

Potential later versions, only after v1 usage demonstrates demand:

- installable PWA shell
- QR transfer for single courses/small payloads
- optional encrypted backup files
- additional course statuses/archive workflow
- custom tag colors
- exact progress sync from external YouTube viewing if YouTube ever exposes a suitable client-side mechanism
- notes/bookmarks
- playback queue across courses
- course goals or schedules
- optional backend sync as a separate deployment mode

