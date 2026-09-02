import {
  MAX_BACKUP_BYTES, createBackupFromSnapshot, mergeBackupData, parseBackup, remapBackupForReplace,
} from '../backup.js'
import { button, h, setText, showToast } from '../dom.js'
import { canPrompt, isInstalled, promptInstall, subscribe, SW_OPT_OUT_KEY } from '../install.js'

function makeBackupFile(backup, prefix = 'course-tracker-backup') {
  return new File(
    [JSON.stringify(backup, null, 2)],
    `${prefix}-${new Date().toISOString().slice(0, 10)}.json`,
    { type: 'application/json' },
  )
}

function downloadFile(file) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function renderSettingsPage(container, { store }) {
  const state = {
    backup: null, error: '', replaceConfirmed: false,
    confirming: null, wiping: false, removingOfflineFiles: false,
  }
  let destroyed = false

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json',
    'aria-label': 'Choose CourseTracker backup',
  })
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) {
      state.backup = null
      state.error = 'That file is too large to be a CourseTracker backup.'
      state.confirming = null
      update()
      return
    }
    loadBackupText(await file.text())
  })

  const errorNote = h('div', { className: 'inline-error', role: 'alert' })
  const previewCounts = h('strong')
  const previewMeta = h('span', { className: 'small muted' })
  const mergeButton = button('Merge', { className: 'button button--primary' })
  const confirmMergeRow = h('div', { className: 'confirm-row' },
    h('span', { className: 'small', text: 'Merging rewrites this browser’s library. A backup of the current state downloads first.' }),
    button('Merge backup', { className: 'button button--primary button--small', onClick: () => void merge() }),
    button('Cancel', { className: 'button button--ghost button--small', onClick: () => { state.confirming = null; update() } }))
  const replaceCheckbox = h('input', { type: 'checkbox', 'aria-label': 'I understand this replaces my local library' })
  const replaceButton = button('Replace local library', { className: 'button button--danger' })
  const preview = h('div', { className: 'backup-preview' },
    previewCounts, previewMeta,
    h('div', { className: 'button-row' }, mergeButton), confirmMergeRow,
    h('label', { className: 'confirm-row' }, replaceCheckbox,
      h('span', { text: 'I understand this replaces my local library on this device.' })),
    replaceButton)

  mergeButton.addEventListener('click', () => { state.confirming = 'merge'; update() })
  replaceCheckbox.addEventListener('change', () => { state.replaceConfirmed = replaceCheckbox.checked; update() })
  replaceButton.addEventListener('click', () => void replace())

  const downloadButton = button('Download backup', { className: 'button button--primary' })
  downloadButton.addEventListener('click', () => void exportBackup(false))
  const exportActions = h('div', { className: 'button-row' }, downloadButton)
  try {
    const probe = makeBackupFile({ schemaVersion: 1, exportedAt: new Date().toISOString(), courses: [] })
    if (navigator.canShare?.({ files: [probe] })) {
      exportActions.append(button('Share to another device', {
        className: 'button button--secondary', onClick: () => void exportBackup(true),
      }))
    }
  } catch { /* File sharing not supported */ }

  // Every state of the install section is built once here and toggled through
  // update(), like the confirm rows below it. Rebuilding on subscription
  // updates would drop focus mid-interaction.
  const installButton = button('Install CourseTracker', { className: 'button button--primary' })
  installButton.addEventListener('click', () => void install())
  const installSteps = h('ol', { className: 'install-steps' },
    h('li', { text: 'Open this page in Safari on iPhone or iPad, or Chrome on Android.' }),
    h('li', { text: 'Tap the Share button on iOS, or the ⋮ menu on Android.' }),
    h('li', { text: 'Choose “Add to Home Screen”, then confirm.' }))
  const installSection = h('section', { className: 'panel settings-section settings-section--wide' },
    h('h2', { text: 'Install on this device' }),
    h('p', { className: 'muted', text: 'Installing gives CourseTracker a home-screen icon and its own window, and it opens without a network. It does not give you offline video — playback and playlist discovery always need YouTube.' }),
    h('div', { className: 'inline-note', text: 'Installing does not move your library. This browser and the installed app can hold separate local data, so export a backup above first, then import it once the installed app opens.' }),
    h('p', { className: 'small muted install-note', text: 'Installing also protects your data. Safari clears storage for websites left unused for about a week, but not for installed apps.' }),
    h('div', { className: 'button-row' }, installButton),
    h('p', { className: 'small subtle install-note', text: 'No install button? Add it by hand:' }),
    installSteps)

  const wipeButton = button('Delete all local data', { className: 'button button--danger' })
  const confirmWipeRow = h('div', { className: 'confirm-row' },
    h('span', { className: 'small', text: 'This erases every course, tag, and resume position stored in this browser. It cannot be undone.' }),
    button('Delete everything', { className: 'button button--danger button--small', onClick: () => void wipe() }),
    button('Cancel', { className: 'button button--ghost button--small', onClick: () => { state.confirming = null; update() } }))
  wipeButton.addEventListener('click', () => { state.confirming = 'wipe'; update() })

  // The escape hatch for a misbehaving offline copy. The removal has to hold
  // across the reload that follows it, or the fresh page would immediately
  // register the same worker again.
  const offlineFilesButton = button('Reload from the server', { className: 'button button--secondary' })
  offlineFilesButton.addEventListener('click', () => void removeOfflineFiles())
  const offlineFilesSection = h('section', { className: 'panel settings-section settings-section--wide' },
    h('h2', { text: 'Offline app files' }),
    h('p', { className: 'muted', text: 'CourseTracker keeps a copy of its own pages and scripts so it can open without a network. These are program files, not your data — your courses and progress are stored separately and are never touched here.' }),
    h('div', { className: 'inline-note', text: 'If the app looks wrong or out of date, this discards that copy and fetches everything fresh. Offline access stays off for the rest of this session and comes back the next time you open CourseTracker.' }),
    h('div', { className: 'button-row' }, offlineFilesButton))

  const page = h('main', { className: 'page page--narrow' },
    h('div', { className: 'page-header' },
      h('div', {},
        h('div', { className: 'eyebrow', text: 'Local-first' }),
        h('h1', { text: 'Settings & Transfer' }),
        h('p', { text: 'Move your CourseTracker library between devices with a versioned backup file.' }))),
    h('div', { className: 'settings-grid' },
      h('section', { className: 'panel settings-section' },
        h('h2', { text: 'Export your library' }),
        h('p', { className: 'muted', text: 'The backup contains course titles, tags, lesson order, watched state, and resume positions. It does not contain video files.' }),
        exportActions),
      h('section', { className: 'panel settings-section' },
        h('h2', { text: 'Import a backup' }),
        h('p', { className: 'muted', text: 'Preview the file first, then merge it with this browser or replace this browser’s local library.' }),
        fileInput, errorNote, preview),
      installSection,
      h('section', { className: 'panel settings-section settings-section--wide' },
        h('h2', { text: 'Privacy & network use' }),
        h('p', { className: 'muted', text: 'Your courses, tags, progress, and resume positions stay in this browser until you export them. CourseTracker has no server. Your browser still contacts YouTube for playlist discovery, embedded playback, thumbnails, and optional lesson metadata.' }),
        h('div', { className: 'inline-note', text: 'There are no CourseTracker accounts, API keys, or analytics. Playback uses youtube-nocookie.com. The offline worker caches only CourseTracker’s own files and sends nothing anywhere; there is no background sync.' })),
      offlineFilesSection,
      h('section', { className: 'panel settings-section settings-section--wide' },
        h('h2', { text: 'Danger zone' }),
        h('p', { className: 'muted', text: 'Export a backup first if you might want this data again.' }),
        h('div', { className: 'button-row' }, wipeButton), confirmWipeRow),
      h('section', { className: 'panel settings-section settings-section--wide' },
        h('h2', { text: 'About CourseTracker' }),
        h('p', { className: 'muted', text: 'One YouTube playlist equals one course. YouTube owns the playlist; CourseTracker owns your local learning progress. Refreshes are always manual.' }),
        h('a', { className: 'button button--secondary', href: '#/', text: 'Back to library' }))))

  container.replaceChildren(page)

  const pending = sessionStorage.getItem('courseTrackerPendingBackup')
  if (pending) {
    sessionStorage.removeItem('courseTrackerPendingBackup')
    loadBackupText(pending)
  } else {
    update()
  }

  // Without releasing this, install.js accumulates a dead callback for every
  // visit to Settings.
  const unsubscribeInstall = subscribe(() => update())
  return { destroy() { destroyed = true; unsubscribeInstall() } }

  function update() {
    if (destroyed) return
    errorNote.hidden = !state.error
    if (state.error) setText(errorNote, state.error)

    preview.hidden = !state.backup
    if (state.backup) {
      const lessons = state.backup.courses.reduce((sum, course) => sum + course.videos.length, 0)
      setText(previewCounts, `${state.backup.courses.length} courses · ${lessons} lessons`)
      setText(previewMeta, `Backup schema v${state.backup.schemaVersion} · exported ${new Date(state.backup.exportedAt).toLocaleString()}`)
      confirmMergeRow.hidden = state.confirming !== 'merge'
      mergeButton.disabled = state.confirming === 'merge'
      replaceButton.disabled = !state.replaceConfirmed
      if (replaceCheckbox.checked !== state.replaceConfirmed) replaceCheckbox.checked = state.replaceConfirmed
    }
    confirmWipeRow.hidden = state.confirming !== 'wipe'
    wipeButton.disabled = state.wiping

    // Already installed: nothing here applies. Otherwise the manual steps stay
    // visible either way, so iOS — which has no install API — is never left
    // without instructions and no user agent sniffing is needed.
    installSection.hidden = isInstalled()
    installButton.hidden = !canPrompt()
    offlineFilesSection.hidden = !('serviceWorker' in navigator)
    offlineFilesButton.disabled = state.removingOfflineFiles
  }

  function loadBackupText(text) {
    try {
      state.backup = parseBackup(JSON.parse(text))
      state.error = ''
    } catch (error) {
      state.backup = null
      state.error = error?.message ?? 'This backup could not be validated.'
    }
    state.confirming = null
    update()
  }

  async function exportBackup(share = false) {
    const snapshot = await store.snapshot()
    const file = makeBackupFile(createBackupFromSnapshot(snapshot))
    if (share && navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'CourseTracker backup' })
        return
      } catch (error) {
        if (error?.name === 'AbortError') return
      }
    }
    downloadFile(file)
  }

  async function merge() {
    if (!state.backup) return
    try {
      const snapshot = await store.snapshot()
      // Merge can overwrite local progress and has no undo, so the pre-merge
      // state always leaves the building first.
      if (snapshot.courses.length) {
        downloadFile(makeBackupFile(createBackupFromSnapshot(snapshot), 'course-tracker-pre-merge'))
      }
      await store.replaceSnapshot(mergeBackupData(snapshot, state.backup))
      showToast('Backup merged into this device.', 'success')
      state.backup = null
      state.confirming = null
      update()
    } catch (error) {
      state.error = error?.message ?? 'Backup merge failed. Your local library was not changed.'
      state.confirming = null
      update()
    }
  }

  async function replace() {
    if (!state.backup || !state.replaceConfirmed) return
    try {
      const snapshot = await store.snapshot()
      if (snapshot.courses.length) {
        downloadFile(makeBackupFile(createBackupFromSnapshot(snapshot), 'course-tracker-pre-replace'))
      }
      await store.replaceSnapshot(remapBackupForReplace(state.backup))
      showToast('Local library replaced from backup.', 'success')
      state.backup = null
      state.replaceConfirmed = false
      state.confirming = null
      update()
    } catch (error) {
      state.error = error?.message ?? 'Backup replace failed. Your local library was not changed.'
      update()
    }
  }

  async function install() {
    const outcome = await promptInstall()
    if (outcome === 'accepted') showToast('CourseTracker installed. Import a backup to bring your library across.', 'success')
    update()
  }

  async function removeOfflineFiles() {
    state.removingOfflineFiles = true
    update()
    try {
      // Read on the next load, before any registration happens.
      sessionStorage.setItem(SW_OPT_OUT_KEY, '1')
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
      const names = await caches.keys()
      await Promise.all(names
        .filter((name) => name.startsWith('course-tracker-'))
        .map((name) => caches.delete(name)))
      // Reload so the page is served by the network rather than the worker
      // that was just unregistered but is still controlling this document.
      location.reload()
    } catch (error) {
      sessionStorage.removeItem(SW_OPT_OUT_KEY)
      // A toast, not state.error: that node lives in the import section and
      // would report this under the wrong heading.
      showToast(error?.message ?? 'Could not remove the offline app files.', 'error')
      state.removingOfflineFiles = false
      update()
    }
  }

  async function wipe() {
    state.wiping = true
    update()
    try {
      await store.clearData()
      state.confirming = null
      showToast('All local CourseTracker data deleted.', 'success')
    } catch (error) {
      state.error = error?.message ?? 'Could not delete local data.'
    } finally {
      state.wiping = false
      update()
    }
  }
}
