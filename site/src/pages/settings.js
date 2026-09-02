import {
  MAX_BACKUP_BYTES, createBackupFromSnapshot, mergeBackupData, parseBackup, remapBackupForReplace,
} from '../backup.js'
import { button, h, setText, showToast } from '../dom.js'

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
    confirming: null, wiping: false,
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

  const wipeButton = button('Delete all local data', { className: 'button button--danger' })
  const confirmWipeRow = h('div', { className: 'confirm-row' },
    h('span', { className: 'small', text: 'This erases every course, tag, and resume position stored in this browser. It cannot be undone.' }),
    button('Delete everything', { className: 'button button--danger button--small', onClick: () => void wipe() }),
    button('Cancel', { className: 'button button--ghost button--small', onClick: () => { state.confirming = null; update() } }))
  wipeButton.addEventListener('click', () => { state.confirming = 'wipe'; update() })

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
      h('section', { className: 'panel settings-section settings-section--wide' },
        h('h2', { text: 'Privacy & network use' }),
        h('p', { className: 'muted', text: 'Your courses, tags, progress, and resume positions stay in this browser until you export them. CourseTracker has no server. Your browser still contacts YouTube for playlist discovery, embedded playback, thumbnails, and optional lesson metadata.' }),
        h('div', { className: 'inline-note', text: 'There are no CourseTracker accounts, API keys, analytics, or background sync in v1. Playback uses youtube-nocookie.com.' })),
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
  return { destroy() { destroyed = true } }

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
