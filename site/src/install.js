/**
 * Holds the browser's deferred install prompt.
 *
 * The listeners below run when this module is evaluated, not when a page asks
 * for them. `beforeinstallprompt` fires early, and app.js awaits an IndexedDB
 * probe before rendering anything, so a listener attached during startup would
 * miss the event on a fast load.
 */

/**
 * Set by Settings just before it reloads, read by app.js on the next load, so
 * that removing the worker is not immediately undone by the reload that
 * follows. It lives here rather than in app.js because both modules import
 * this one, and the other direction would be a cycle.
 *
 * sessionStorage, not IndexedDB: this is an escape hatch for the current
 * session, not a stored preference. Closing the app restores offline access.
 */
export const SW_OPT_OUT_KEY = 'courseTrackerSkipServiceWorker'

let deferredPrompt = null
let installed = false
const subscribers = new Set()

function notify() {
  for (const callback of subscribers) callback()
}

window.addEventListener('beforeinstallprompt', (event) => {
  // Without preventDefault Chrome shows its own mini-infobar on Android
  // alongside the in-app button.
  event.preventDefault()
  deferredPrompt = event
  notify()
})

window.addEventListener('appinstalled', () => {
  installed = true
  deferredPrompt = null
  notify()
})

/**
 * True once the app is running as an installed app. minimal-ui and fullscreen
 * are checked too, because a browser that does not honour `standalone` falls
 * back to one of them; navigator.standalone is the iOS signal.
 */
export function isInstalled() {
  if (installed) return true
  const modes = ['standalone', 'minimal-ui', 'fullscreen']
  if (modes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)) return true
  return navigator.standalone === true
}

/** True when the browser has offered a prompt we can still fire. */
export function canPrompt() {
  return deferredPrompt !== null
}

/**
 * Shows the browser's install dialog.
 *
 * The deferred event is single use — a second prompt() throws — so it is
 * cleared whether the user accepts or dismisses.
 *
 * @returns {Promise<'accepted' | 'dismissed' | 'unavailable'>}
 */
export async function promptInstall() {
  const event = deferredPrompt
  if (!event) return 'unavailable'
  deferredPrompt = null
  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    if (outcome === 'accepted') {
      installed = true
      // Installed apps are granted persistent storage on Chrome and Firefox,
      // which exempts this library from routine storage eviction. No-op on
      // Safari, which decides on its own.
      await navigator.storage?.persist?.().catch(() => {})
    }
    return outcome === 'accepted' ? 'accepted' : 'dismissed'
  } catch {
    return 'dismissed'
  } finally {
    notify()
  }
}

/** @returns {() => void} unsubscribe */
export function subscribe(callback) {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}
