/**
 * CourseTracker app-shell service worker.
 *
 * Classic script, no imports: module service workers are still not uniformly
 * available, and this file must never need a build step.
 *
 * IMPORTANT: this file must stay at the site root. Its URL determines the
 * worker's scope, so moving it into src/ would cap scope at /src/ and silently
 * stop it controlling the app.
 *
 * SHELL_REVISION is content-addressed: `npm run pwa:rev` recomputes it from the
 * bytes of every SHELL file, and tests/pwa.test.mjs fails until it matches.
 * Without that, editing a module without touching this file would leave every
 * installed user pinned to stale code forever, because a browser only
 * reinstalls a worker when the worker script itself changes.
 */
const SHELL_REVISION = '74cbf1a111a8'
const CACHE = `course-tracker-${SHELL_REVISION}`

const SHELL = [
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './src/app.js',
  './src/async.js',
  './src/backup.js',
  './src/dom.js',
  './src/domain.js',
  './src/install.js',
  './src/storage.js',
  './src/view-models.js',
  './src/youtube.js',
  './src/pages/add.js',
  './src/pages/course.js',
  './src/pages/library.js',
  './src/pages/settings.js',
]

const NAVIGATION_TIMEOUT_MS = 2500

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // GitHub Pages sends Cache-Control: max-age=600. The worker script itself
    // bypasses the HTTP cache, but these subresource fetches would not, so a
    // fresh install could precache bytes up to ten minutes old.
    await Promise.all(SHELL.map(async (path) => {
      const request = new Request(new URL(path, self.location.href), { cache: 'reload' })
      const response = await fetch(request)
      // cache.put stores anything, including a Pages 404 page, so status is
      // checked here rather than relying on addAll to reject.
      if (!response.ok) throw new Error(`precache failed for ${path}: ${response.status}`)
      await cache.put(request, response)
    }))
  })())
  // No skipWaiting here. A new worker waits until the page asks for it.
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('course-tracker-') && name !== CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  // Everything YouTube — the IFrame API script, player frames, i.ytimg
  // thumbnails, the oEmbed call — falls through untouched. Returning early is
  // deliberate: wrapping a passthrough in respondWith(fetch(request)) reissues
  // the request through the worker and can break opaque and range responses.
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }
  event.respondWith(handleAsset(request))
})

/**
 * Network-first. index.html carries the Content Security Policy, so serving it
 * cache-first would pin a security-relevant document until the next worker
 * update. The timeout keeps a dead network from stalling the launch.
 */
async function handleNavigation(request) {
  try {
    return await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS)
  } catch {
    const cached = await matchShell(new URL('./index.html', self.location.href))
    // A rejected respondWith renders a network error for the document itself,
    // which the user cannot escape because this worker is serving the page.
    // Every branch has to end in something.
    return cached ?? fetch(request).catch(() => new Response(
      'CourseTracker is offline and no cached copy is available.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    ))
  }
}

/**
 * Cache-first, precache-only. A miss goes to the network and is NOT stored, so
 * the cache stays exactly equal to SHELL, cannot grow without bound, and
 * SHELL_REVISION keeps describing its contents accurately.
 */
async function handleAsset(request) {
  const cached = await matchShell(request)
  if (cached) return cached
  return fetch(request).catch(() => new Response('', { status: 504 }))
}

/**
 * Scoped to this revision's cache rather than caches.match's search across all
 * of them, so a cache left behind by a failed activation can never serve a
 * response the current worker did not precache.
 */
async function matchShell(request) {
  const cache = await caches.open(CACHE)
  return cache.match(request, { ignoreSearch: true })
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
