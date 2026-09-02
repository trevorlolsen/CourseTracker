import { h } from './dom.js'
import { checkIndexedDb, CourseStore } from './storage.js'
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
  const shell = h('div', { className: 'shell' },
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
    else if (path === '/settings') currentPage = await renderSettingsPage(view, { store, query })
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
}

void start()
