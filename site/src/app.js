import { h, showToast } from './dom.js'
import { checkIndexedDb, CourseStore } from './storage.js'
// Also imported for its side effect: the module captures `beforeinstallprompt`
// on evaluation, which happens before start() finishes its IndexedDB probe.
import { SW_OPT_OUT_KEY } from './install.js'
import { renderAddPage } from './pages/add.js'
import { renderCoursePage } from './pages/course.js'
import { renderLibraryPage } from './pages/library.js'
import { renderSettingsPage } from './pages/settings.js'

const app = document.getElementById('app')
let store
let currentPage = null
let currentRouteKey = null
let shellNodes = null

function parseHash() {
  const raw = (location.hash.slice(1) || '/').replace(/^\/?/, '/')
  const question = raw.indexOf('?')
  const path = question >= 0 ? raw.slice(0, question) : raw
  const query = new URLSearchParams(question >= 0 ? raw.slice(question + 1) : '')
  return { path, query }
}

function navLink(label, href) {
  const targetPath = href.slice(1).split('?')[0]
  const link = h('a', { className: 'nav-link', href, text: label })
  link.dataset.targetPath = targetPath
  return link
}

function buildShell() {
  const links = [
    navLink('Library', '#/'),
    navLink('Settings', '#/settings'),
    navLink('+ Add', '#/add'),
  ]
  links[2].classList.add('nav-link--primary')
  const view = h('div', { id: 'route-view' })
  // One strip for the whole app rather than a notice per page. It is advisory:
  // navigator.onLine reports true on a captive portal, so the copy names what
  // stops working instead of asserting the network is down.
  const offlineStrip = h('div', {
    className: 'offline-strip',
    role: 'status',
    text: 'Offline. Your library and progress still work; adding playlists and playback need YouTube.',
  })
  const shell = h('div', { className: 'shell' },
    offlineStrip,
    h('header', { className: 'topbar' },
      h('div', { className: 'topbar__inner' },
        h('a', { className: 'brand', href: '#/', 'aria-label': 'CourseTracker home' },
          h('span', { className: 'brand__mark', 'aria-hidden': 'true' }),
          h('span', { className: 'brand__name', text: 'CourseTracker' }),
          h('span', { className: 'brand__subtitle', text: 'YouTube courses, tracked.' }),
        ),
        h('span', { className: 'topbar__spacer' }),
        h('nav', { className: 'topbar__nav', 'aria-label': 'Primary navigation' }, ...links),
      )),
    view)
  app.replaceChildren(shell)

  const syncOnline = () => { offlineStrip.hidden = navigator.onLine !== false }
  syncOnline()
  window.addEventListener('online', syncOnline)
  window.addEventListener('offline', syncOnline)

  return { shell, view, links }
}

function markCurrent(path) {
  for (const link of shellNodes.links) {
    const target = link.dataset.targetPath
    const isCurrent = target === '/' ? path === '/' : path.startsWith(target)
    if (isCurrent) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

function showStorageError() {
  app.replaceChildren(h('main', { className: 'storage-block' },
    h('section', { className: 'panel' },
      h('div', { className: 'empty-state__icon', text: '▣' }),
      h('h1', { text: 'Local storage is required' }),
      h('p', { className: 'muted', text: 'CourseTracker needs IndexedDB to save your courses and progress. This browser or browsing mode is not providing persistent local storage.' }),
      h('p', { className: 'small subtle', text: 'Try a normal browser window with local site storage enabled.' }),
    ),
  ))
}

/** Identity of a screen. Two URLs with the same key are the same live page. */
function routeKey(path) {
  return path.startsWith('/course/') ? path : path
}

async function route() {
  const { path, query } = parseHash()
  const key = routeKey(path)

  // A query-only change on the same screen is handled by the live page, so
  // long-lived state (notably the YouTube iframe) is never torn down.
  if (key === currentRouteKey && currentPage?.onQueryChange) {
    currentPage.onQueryChange(query)
    return
  }

  currentPage?.destroy?.()
  currentPage = null
  currentRouteKey = key
  if (!shellNodes) shellNodes = buildShell()
  markCurrent(path)

  const view = shellNodes.view
  view.replaceChildren(h('div', { className: 'loading-screen' },
    h('span', { className: 'spinner', 'aria-label': 'Loading' })))

  try {
    if (path === '/') currentPage = await renderLibraryPage(view, { store })
    else if (path === '/add') currentPage = await renderAddPage(view, { store })
    else if (path === '/settings') currentPage = await renderSettingsPage(view, { store })
    else if (path.startsWith('/course/')) {
      const courseId = decodeURIComponent(path.slice('/course/'.length))
      currentPage = await renderCoursePage(view, { store, courseId, query })
    } else {
      view.replaceChildren(h('main', { className: 'page' },
        h('div', { className: 'empty-state' },
          h('h1', { text: 'Page not found' }),
          h('a', { className: 'button button--primary', href: '#/', text: 'Back to library' }))))
    }
  } catch (error) {
    console.error(error)
    view.replaceChildren(h('main', { className: 'page' },
      h('div', { className: 'empty-state' },
        h('h1', { text: 'CourseTracker hit a problem' }),
        h('p', { className: 'muted', text: error?.message ?? 'An unexpected local error occurred.' }),
        h('button', { className: 'button button--primary', type: 'button', text: 'Try again', onClick: () => void route() }))))
  }
}

// The E2E test double replaces YouTube with fakes. It is only honoured on a
// local server, so a shared `?e2e=1` link cannot flip the deployed app into
// test mode.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * Registers the app-shell worker and wires the update prompt.
 *
 * This runs on every host, including localhost, so the deployed code path is
 * the one exercised in development and in the browser tests. `npm run dev`
 * staleness is handled by updateViaCache:'none', a hard reload, or DevTools →
 * Application → "Update on reload"; Settings carries a kill switch for a bad
 * worker.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  // Settings → "Reload from the server" sets this before reloading. Without it
  // the reload would re-register the worker it just removed, which would make
  // the escape hatch useless against a worker that is actually misbehaving.
  // Session-scoped on purpose: offline access returns next time the app opens.
  if (sessionStorage.getItem(SW_OPT_OUT_KEY)) return

  // Resolved against this module's URL, not the document's. sw.js has to stay
  // at the site root: its URL sets the worker's scope, and a copy under src/
  // would only control /src/.
  const swUrl = new URL('../sw.js', import.meta.url)

  // clients.claim() in the worker's activate step fires controllerchange on a
  // first install too. Reloading on that would reload every new visitor for no
  // reason, so a reload requires both a prior controller and the user having
  // asked for it.
  const hadController = Boolean(navigator.serviceWorker.controller)
  let reloadRequested = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || !reloadRequested) return
    reloadRequested = false
    // Preserves the hash, so the user stays on the lesson they were watching.
    location.reload()
  })

  void navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' }).then((registration) => {
    const offerUpdate = (worker) => {
      if (!worker) return
      showToast('A new version of CourseTracker is ready.', 'info', {
        action: {
          label: 'Reload',
          onClick: () => { reloadRequested = true; worker.postMessage('SKIP_WAITING') },
        },
      })
    }

    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting)

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      worker?.addEventListener('statechange', () => {
        // A controller already present is what separates "an update is waiting"
        // from "this is the very first install".
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker)
      })
    })

    // Browsers check for worker updates on navigation, and this is a hash
    // router, so a tab left open for days would never check on its own.
    let lastCheck = Date.now()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return
      lastCheck = Date.now()
      void registration.update().catch(() => {})
    })
  }).catch((error) => {
    // An unavailable worker costs offline launch, not the app.
    console.warn('Service worker registration failed', error)
  })
}

async function start() {
  const hashQuery = new URLSearchParams((location.hash.split('?')[1] ?? ''))
  const e2eRequested = new URLSearchParams(location.search).get('e2e') === '1' || hashQuery.get('e2e') === '1'
  const e2e = e2eRequested && LOCAL_HOSTS.has(location.hostname)
  if (e2e) {
    const { installE2EAdapter } = await import('./e2e-adapter.js')
    installE2EAdapter()
  }

  app.replaceChildren(h('div', { className: 'loading-screen' },
    h('span', { className: 'spinner', 'aria-label': 'Checking local storage' })))
  if (!(await checkIndexedDb())) {
    showStorageError()
    return
  }
  store = new CourseStore()
  window.addEventListener('hashchange', () => void route())
  await route()
  // After the first render: registration is never on the critical path.
  registerServiceWorker()
}

void start()
