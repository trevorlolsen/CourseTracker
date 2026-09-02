import { runLimited } from '../async.js'
import { MAX_BACKUP_BYTES } from '../backup.js'
import { normalizeTags, parseTagInput } from '../domain.js'
import { button, h, linkButton, reconcileList, setClass, setText, showToast } from '../dom.js'
import { parsePlaylistInputs } from '../view-models.js'
import { canonicalPlaylistUrl, discoverPlaylist, enrichPlaylist, enrichVideo } from '../youtube.js'

const INVALID_URL_MESSAGE = 'This does not look like a YouTube playlist URL.'
const DISCOVERY_ERROR_MESSAGE = "CourseTracker couldn't read this playlist from YouTube. Check that the playlist is accessible and try again."

function statusLabel(status) {
  return ({
    idle: 'Ready', discovering: 'Discovering…', ready: 'Ready to add',
    duplicate: 'Already added', error: 'Needs attention', added: 'Added',
  })[status] ?? status
}

export async function renderAddPage(container, { store }) {
  const existingCourses = await store.listCourses()
  const tagSuggestions = normalizeTags(existingCourses.flatMap((course) => course.tags ?? [])).sort((a, b) => a.localeCompare(b))
  const state = { items: [], invalid: [] }
  let destroyed = false

  const textarea = h('textarea', {
    className: 'textarea', rows: 6, id: 'playlist-urls',
    placeholder: 'https://www.youtube.com/playlist?list=…\nhttps://www.youtube.com/playlist?list=…',
    'aria-label': 'Playlist URLs',
  })
  const discover = button('Discover playlist(s) →', { className: 'button button--primary' })
  const fileInput = h('input', {
    type: 'file', accept: '.txt,.json,text/plain,application/json',
    'aria-label': 'Import playlist list or backup file',
  })
  const invalidNote = h('div', { className: 'inline-error' })
  const results = h('section', { className: 'import-results', 'aria-label': 'Playlist import results' })
  const datalist = h('datalist', { id: 'tag-suggestions' }, ...tagSuggestions.map((tag) => h('option', { value: tag })))

  discover.addEventListener('click', () => void discoverAll())
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    // Reset so re-selecting the same file after a failure still fires change.
    fileInput.value = ''
    void handleFile(file)
  })

  const page = h('main', { className: 'page page--narrow' },
    h('div', { className: 'page-header' },
      h('div', {},
        h('div', { className: 'eyebrow', text: 'Import' }),
        h('h1', { text: 'Add Course' }),
        h('p', { text: 'Paste one or several public YouTube playlist URLs. No account or API key is required.' }))),
    h('div', { className: 'import-steps', 'aria-label': 'Import steps' },
      ...['Paste', 'Discover', 'Preview', 'Add'].map((label, index) => h('div', { className: 'step step--active' },
        h('span', { className: 'step__num', text: String(index + 1) }), label))),
    h('section', { className: 'panel import-form' },
      h('div', { className: 'field' }, h('label', { for: 'playlist-urls', text: 'Playlist URLs' }), textarea),
      h('div', { className: 'button-row' }, discover),
      h('div', { className: 'file-drop' },
        h('div', { className: 'small', text: 'Or import a .txt list, JSON list, or CourseTracker backup' }), fileInput)),
    invalidNote, results, datalist)

  container.replaceChildren(page)
  update()
  return { destroy() { destroyed = true } }

  function update() {
    if (destroyed) return
    invalidNote.hidden = state.invalid.length === 0
    if (state.invalid.length) {
      setText(invalidNote, `${INVALID_URL_MESSAGE} ${state.invalid.length} line${state.invalid.length === 1 ? '' : 's'} skipped.`)
    }
    results.hidden = state.items.length === 0
    reconcileList(results, state.items, (item) => item.playlistId, createItemCard, updateItemCard)
  }

  async function discoverAll() {
    const parsed = parsePlaylistInputs(textarea.value)
    state.invalid = parsed.invalid
    state.items = parsed.valid.map(({ rawUrl, playlistId }) => ({
      rawUrl,
      playlistId,
      status: 'idle',
      videoIds: [],
      title: `YouTube Playlist ${playlistId.slice(0, 8)}`,
      titleSource: 'fallback',
      tagsText: '',
      titleEdited: false,
    }))
    update()
    await runLimited(state.items, 2, discoverItem)
  }

  async function discoverItem(item) {
    item.status = 'discovering'
    item.error = undefined
    update()
    try {
      const existing = await store.getCourseByPlaylistId(item.playlistId)
      if (existing) {
        item.status = 'duplicate'
        item.existingCourse = existing
        update()
        return
      }
      const result = await discoverPlaylist(item.playlistId)
      if (!result.videoIds?.length) throw new Error('Playlist did not expose any videos')
      item.videoIds = result.videoIds
      item.status = 'ready'
      update()

      void enrichPlaylist(item.playlistId).then((metadata) => {
        if (destroyed) return
        if (metadata.authorName) item.authorName = metadata.authorName
        if (metadata.title && !item.titleEdited) {
          item.title = metadata.title
          item.titleSource = 'youtube'
        }
        update()
      }).catch(() => {})
    } catch (error) {
      console.warn('Playlist discovery failed', error)
      item.status = 'error'
      item.error = DISCOVERY_ERROR_MESSAGE
      update()
    }
  }

  async function addItem(item) {
    const now = Date.now()
    const courseId = crypto.randomUUID()
    const course = {
      id: courseId,
      playlistId: item.playlistId,
      // Store the canonical URL, never the pasted text: the raw input has only
      // been checked for host and scheme, and a stored URL is a future link.
      sourceUrl: canonicalPlaylistUrl(item.playlistId),
      title: item.title.trim() || `YouTube Playlist ${item.playlistId.slice(0, 8)}`,
      titleSource: item.titleEdited ? 'user' : item.titleSource,
      ...(item.authorName ? { authorName: item.authorName } : {}),
      tags: parseTagInput(item.tagsText),
      currentVideoId: item.videoIds[0],
      thumbnailVideoId: item.videoIds[0],
      createdAt: now,
      updatedAt: now,
      metadataUpdatedAt: now,
    }
    const videos = item.videoIds.map((videoId, position) => ({
      courseId, videoId, position,
      watched: false, resumeSeconds: 0, progressUpdatedAt: now,
      firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown',
    }))
    try {
      await store.createCourse(course, videos)
      item.status = 'added'
      item.existingCourse = course
      update()
      void runLimited(item.videoIds, 4, async (videoId) => {
        const metadata = await enrichVideo(videoId)
        const patch = {
          ...(metadata.title ? { title: metadata.title } : {}),
          ...(metadata.authorName ? { authorName: metadata.authorName } : {}),
          ...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
        }
        if (Object.keys(patch).length) await store.updateVideo(courseId, videoId, patch)
      })
      showToast(`${course.title} added`, 'success')
    } catch (error) {
      item.status = 'error'
      item.error = error?.name === 'ConstraintError'
        ? 'This playlist is already in your library.'
        : 'CourseTracker could not save this course locally.'
      update()
    }
  }

  async function handleFile(file) {
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) {
      showToast('That file is too large to import.', 'error')
      return
    }
    const text = await file.text()
    if (file.name.toLocaleLowerCase().endsWith('.json')) {
      try {
        const parsed = JSON.parse(text)
        if (parsed?.schemaVersion && Array.isArray(parsed?.courses)) {
          try {
            sessionStorage.setItem('courseTrackerPendingBackup', text)
          } catch {
            // sessionStorage has a far smaller quota than the import cap.
            showToast('That backup is too large to hand off. Import it from Settings instead.', 'error')
            return
          }
          location.hash = '#/settings?import=1'
          return
        }
        if (Array.isArray(parsed)) textarea.value = parsed.filter((value) => typeof value === 'string').join('\n')
        else if (Array.isArray(parsed?.playlists)) textarea.value = parsed.playlists.filter((value) => typeof value === 'string').join('\n')
        else throw new Error('Not a playlist list or CourseTracker backup')
      } catch (error) {
        showToast(error.message || 'Could not read this JSON file.', 'error')
        return
      }
    } else {
      textarea.value = text
    }
    if (!textarea.value.trim()) showToast('That file contained no playlist URLs.', 'info')
    update()
  }

  // ------------------------------------------------------------- item cards

  function createItemCard(item) {
    const title = h('strong')
    const playlistId = h('div', { className: 'small muted' })
    const status = h('span', { className: 'status' })
    const head = h('div', { className: 'import-item__head' }, h('div', {}, title, playlistId), status)

    const spinnerRow = h('div', { className: 'button-row' },
      h('span', { className: 'spinner', 'aria-hidden': 'true' }),
      h('span', { className: 'muted small', text: 'Reading the playlist from YouTube…' }))

    const errorNote = h('div', { className: 'inline-error' })
    const retry = button('Retry', { className: 'button button--secondary button--small' })
    const openOnYouTube = linkButton('Open playlist on YouTube', canonicalPlaylistUrl(item.playlistId), 'button button--secondary button--small')
    const removeFromBatch = button('Remove from batch', { className: 'button button--ghost button--small' })
    const errorRow = h('div', { className: 'button-row' }, retry, openOnYouTube, removeFromBatch)

    const resolvedNote = h('div', {})
    const openExisting = linkButton('Open existing course', '#/', 'button button--primary button--small')
    const refreshExisting = linkButton('Refresh existing course', '#/', 'button button--secondary button--small')
    const skip = button('Skip', { className: 'button button--ghost button--small' })
    const resolvedRow = h('div', { className: 'button-row' }, openExisting, refreshExisting, skip)

    const readyNote = h('div', { className: 'inline-note' })
    const titleInput = h('input', { className: 'input', type: 'text', 'aria-label': `Course title for ${item.playlistId}` })
    const tagsInput = h('input', {
      className: 'input', type: 'text', placeholder: 'Rust, Web Dev, Beginner',
      'aria-label': `Tags for ${item.playlistId}`, list: 'tag-suggestions',
    })
    const addButton = button('Add Course', { className: 'button button--primary' })
    const readyBlock = h('div', {},
      h('div', { className: 'field' }, h('label', { text: 'Course title' }), titleInput),
      h('div', { className: 'field' }, h('label', { text: 'Tags' }), tagsInput),
      h('div', { className: 'button-row' }, addButton))

    // These handlers read from the card's bound item, which is refreshed on
    // every update, so background metadata can never overwrite typed input.
    titleInput.addEventListener('input', () => {
      card._item.title = titleInput.value
      card._item.titleEdited = true
      card._item.titleSource = 'user'
    })
    tagsInput.addEventListener('input', () => { card._item.tagsText = tagsInput.value })
    addButton.addEventListener('click', () => { addButton.disabled = true; void addItem(card._item) })
    retry.addEventListener('click', () => void discoverItem(card._item))
    const drop = () => { state.items = state.items.filter((value) => value !== card._item); update() }
    removeFromBatch.addEventListener('click', drop)
    skip.addEventListener('click', drop)

    const card = h('article', { className: 'panel import-item' },
      head, spinnerRow, errorNote, errorRow, resolvedNote, resolvedRow, readyNote, readyBlock)
    card._parts = {
      title, playlistId, status, spinnerRow, errorNote, errorRow,
      resolvedNote, resolvedRow, openExisting, refreshExisting,
      readyNote, readyBlock, titleInput, tagsInput, addButton,
    }
    return card
  }

  function updateItemCard(card, item) {
    card._item = item
    const p = card._parts
    setText(p.title, item.title)
    setText(p.playlistId, item.playlistId)
    setText(p.status, statusLabel(item.status))
    setClass(p.status, `status status--${item.status}`)

    p.spinnerRow.hidden = item.status !== 'discovering'

    const isError = item.status === 'error'
    p.errorNote.hidden = !isError
    p.errorRow.hidden = !isError
    if (isError) setText(p.errorNote, item.error ?? DISCOVERY_ERROR_MESSAGE)

    const isResolved = item.status === 'duplicate' || item.status === 'added'
    p.resolvedNote.hidden = !isResolved
    p.resolvedRow.hidden = !isResolved || !item.existingCourse
    if (isResolved) {
      setText(p.resolvedNote, item.status === 'added'
        ? 'This course is now in your local library.'
        : 'This playlist is already in your library.')
      setClass(p.resolvedNote, item.status === 'added' ? 'inline-note' : 'inline-error')
      if (item.existingCourse) {
        const href = `#/course/${encodeURIComponent(item.existingCourse.id)}`
        p.openExisting.href = href
        p.refreshExisting.href = `${href}?refresh=1`
        p.refreshExisting.hidden = item.status !== 'duplicate'
      }
    }

    const isReady = item.status === 'ready'
    p.readyNote.hidden = !isReady
    p.readyBlock.hidden = !isReady
    if (isReady) {
      setText(p.readyNote, `${item.videoIds.length} lessons discovered. Optional lesson details can continue loading after you add the course.`)
      // Never clobber a field the user is actively editing.
      if (document.activeElement !== p.titleInput && p.titleInput.value !== item.title) p.titleInput.value = item.title
      if (document.activeElement !== p.tagsInput && p.tagsInput.value !== item.tagsText) p.tagsInput.value = item.tagsText
      p.addButton.disabled = false
    }
  }
}
