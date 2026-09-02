import { runLimited } from '../async.js'
import { createBackupFromSnapshot } from '../backup.js'
import {
  diffPlaylist, isMassRemoval, parseTagInput, resolveProgressUpdate, selectNextUnwatched,
} from '../domain.js'
import {
  button, formatDuration, h, progressBar, reconcileList, setClass, setText, shortVideoLabel, showToast,
} from '../dom.js'
import { buildCourseViewModel } from '../view-models.js'
import { canonicalWatchUrl, discoverPlaylist, enrichVideo, mountPlayer } from '../youtube.js'

const AUTOSAVE_INTERVAL_MS = 5000

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function notFound(container) {
  container.replaceChildren(h('main', { className: 'page' },
    h('div', { className: 'empty-state' },
      h('h1', { text: 'Course not found' }),
      h('a', { className: 'button button--primary', href: '#/', text: 'Back to library' }),
    )))
  return { destroy() {} }
}

/**
 * The course page is built once and then patched in place.
 *
 * The player subtree must never be detached: moving an iframe in the DOM —
 * even re-appending it to the same parent — forces it to reload. So `update()`
 * touches text, classes and the lesson list only, and the player is driven
 * separately through its handle.
 */
export async function renderCoursePage(container, { store, courseId, query }) {
  let course = await store.getCourse(courseId)
  if (!course) return notFound(container)

  let videos = await store.getCourseVideos(courseId)
  let currentVideo
  let model
  let showRemoved = false
  // Opens filtered: a half-finished course should show what is left to watch,
  // not bury it under rows the viewer is already done with. Page-local like
  // showRemoved, so it resets on navigation rather than becoming a setting.
  let hideWatched = true
  let refreshSummary
  let pendingRefresh = null
  let editing = false
  let confirmingDelete = false
  let refreshing = false
  let destroyed = false
  let warnedAboutStorage = false

  let playerHandle
  let playerMountedVideoId
  // Cleared on lesson change or a backward seek: an explicit "unwatched" must
  // not be undone by the tail of the same playback session.
  let suppressAutoComplete = false

  const nodes = buildSkeleton()
  container.replaceChildren(nodes.page)

  const requestedVideoId = query.get('video') ?? undefined
  recomputeModel(requestedVideoId)

  if (currentVideo) {
    const now = Date.now()
    course = { ...course, currentVideoId: currentVideo.videoId, lastOpenedAt: now, updatedAt: now }
    await store.updateCourse(course.id, { currentVideoId: currentVideo.videoId, lastOpenedAt: now, updatedAt: now })
  }

  update()
  await mountPlayerOnce()

  const autosave = setInterval(() => {
    const live = playerHandle?.snapshot?.()
    if (live?.state === 'playing') void flush(live)
  }, AUTOSAVE_INTERVAL_MS)

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush(playerHandle?.snapshot?.())
  }
  document.addEventListener('visibilitychange', onVisibility)

  if (query.get('refresh') === '1') setTimeout(() => { if (!destroyed) void refreshPlaylist() }, 0)

  return {
    destroy() {
      destroyed = true
      clearInterval(autosave)
      document.removeEventListener('visibilitychange', onVisibility)
      nodes.releaseLayout()
      void flush(playerHandle?.snapshot?.())
      playerHandle?.destroy?.()
      playerHandle = undefined
    },
    onQueryChange(nextQuery) {
      const videoId = nextQuery.get('video')
      if (videoId && videoId !== currentVideo?.videoId) void goToVideo(videoId, { updateUrl: false })
    },
  }

  // ---------------------------------------------------------------- skeleton

  function buildSkeleton() {
    const title = h('h1', { className: 'course-header__title' })
    const editButton = button('Edit course', { className: 'button button--ghost button--small' })
    const refreshButton = button('↻ Refresh playlist', { className: 'button button--secondary button--small' })
    const retryButton = button('Retry lesson details', { className: 'button button--secondary button--small' })
    const exportButton = button('Export course', { className: 'button button--ghost button--small' })
    const tags = h('div', { className: 'tags' })
    const bar = progressBar(0, 'Course progress')
    const caption = h('div', { className: 'small muted progress-caption' })

    const editPanel = buildEditPanel()

    const header = h('section', { className: 'course-header' },
      h('div', { className: 'course-header__top' },
        h('div', { className: 'course-header__identity' },
          h('div', { className: 'eyebrow', text: 'YouTube course' }), title),
        h('div', { className: 'button-row' }, refreshButton, retryButton, exportButton, editButton),
      ),
      tags, bar, caption, editPanel.root,
    )

    const playerHost = h('div', { className: 'player-frame', 'aria-label': 'YouTube player' },
      h('div', { className: 'player-placeholder', text: 'Loading YouTube player…' }))
    const watchedButton = button('✓ Mark as watched', { className: 'button button--primary' })
    const nextButton = button('Next unwatched →', { className: 'button button--secondary' })
    const youtubeLink = h('a', { className: 'button button--secondary', target: '_blank', rel: 'noreferrer', text: 'Open on YouTube ↗' })
    const warningHost = h('div', { className: 'player-warning' })
    const lessonEyebrow = h('div', { className: 'eyebrow' })
    const lessonTitle = h('strong')
    const resumeHint = h('div', { className: 'small muted' })
    const currentPanel = h('div', { className: 'panel current-lesson' }, lessonEyebrow, lessonTitle, resumeHint)
    const playerActions = h('div', { className: 'player-actions' }, watchedButton, nextButton, youtubeLink)
    const playerColumn = h('section', { className: 'player-column' },
      playerHost, playerActions, warningHost, currentPanel)

    const disclosure = button('Course Content ▴', { className: 'button button--secondary lesson-disclosure', 'aria-expanded': 'true', 'aria-label': 'Course Content' })
    const lessonCount = h('div', { className: 'small muted' })
    const watchedToggleInput = h('input', { type: 'checkbox', checked: hideWatched, 'aria-label': 'Hide completed lessons' })
    const watchedToggle = h('label', { className: 'small muted lesson-toggle' }, watchedToggleInput, ' Hide completed')
    const removedToggleInput = h('input', { type: 'checkbox', 'aria-label': 'Show removed lessons' })
    const removedToggle = h('label', { className: 'small muted lesson-toggle removed-toggle' }, removedToggleInput, ' Show removed lessons')
    const lessonHeader = h('div', { className: 'lesson-panel__header' },
      h('div', {}, h('strong', { text: 'Course Content' }), lessonCount),
      h('div', { className: 'lesson-panel__toggles' }, watchedToggle, removedToggle))
    const lessonList = h('div', { className: 'lesson-list', role: 'list', 'aria-label': 'Course lessons' })
    const lessonContent = h('div', { className: 'lesson-panel__content' }, lessonList)
    const lessonPanel = h('aside', { className: 'panel lesson-panel' }, disclosure, lessonHeader, lessonContent)

    const summary = h('div', { className: 'refresh-summary', role: 'status' })
    const duplicateNote = h('div', { className: 'inline-error' })
    const emptyNote = h('div', { className: 'empty-state' },
      h('h2', { text: 'No active lessons' }),
      h('p', { className: 'muted', text: 'Refresh this playlist to check for available videos.' }))

    const page = h('main', { className: 'page' }, header,
      h('div', { className: 'course-layout' }, playerColumn, lessonPanel),
      summary, duplicateNote, emptyNote)

    let contentExpanded = true
    disclosure.addEventListener('click', () => {
      contentExpanded = !contentExpanded
      disclosure.setAttribute('aria-expanded', String(contentExpanded))
      setText(disclosure, contentExpanded ? 'Course Content ▴' : 'Course Content ▾')
      lessonContent.hidden = !contentExpanded
    })
    // Below the two-column breakpoint the actions move to the end of the page
    // and stick to the bottom of the viewport, so they stay in reach however
    // far the viewer has scrolled. The node is MOVED, never copied: a second
    // set of buttons would give two elements the same accessible name.
    const wideLayout = window.matchMedia('(min-width: 1024px)')
    const placeActions = () => {
      const parent = wideLayout.matches ? playerColumn : page
      if (playerActions.parentNode === parent) return
      if (wideLayout.matches) playerColumn.insertBefore(playerActions, warningHost)
      else page.append(playerActions)
      setClass(playerActions, `player-actions${wideLayout.matches ? '' : ' player-actions--docked'}`)
    }
    wideLayout.addEventListener('change', placeActions)
    placeActions()

    removedToggleInput.addEventListener('change', () => { showRemoved = removedToggleInput.checked; update() })
    watchedToggleInput.addEventListener('change', () => { hideWatched = watchedToggleInput.checked; update() })
    refreshButton.addEventListener('click', () => void refreshPlaylist())
    retryButton.addEventListener('click', () => void retryLessonDetails())
    exportButton.addEventListener('click', () => void exportCourse())
    editButton.addEventListener('click', () => { editing = !editing; confirmingDelete = false; update() })
    watchedButton.addEventListener('click', () => void setWatched(!currentVideo?.watched))
    nextButton.addEventListener('click', () => {
      const next = selectNextUnwatched(videos, currentVideo?.videoId)
      if (next) void goToVideo(next.videoId)
      else showToast('No other unwatched lessons remain.', 'info')
    })

    return {
      page, title, tags, bar, caption, refreshButton, retryButton, editButton, editPanel,
      playerHost, playerColumn, playerActions, lessonPanel, watchedButton, nextButton, youtubeLink, warningHost,
      lessonEyebrow, lessonTitle, resumeHint, currentPanel,
      lessonCount, watchedToggle, watchedToggleInput, removedToggle, removedToggleInput,
      lessonList, summary, duplicateNote, emptyNote,
      releaseLayout: () => wideLayout.removeEventListener('change', placeActions),
    }
  }

  function buildEditPanel() {
    const titleInput = h('input', { className: 'input', type: 'text', 'aria-label': 'Course title' })
    const tagsInput = h('input', { className: 'input', type: 'text', 'aria-label': 'Course tags', placeholder: 'Rust, Web Dev, Beginner' })
    const save = button('Save changes', { className: 'button button--primary button--small' })
    const cancel = button('Cancel', { className: 'button button--ghost button--small' })
    const remove = button('Delete course', { className: 'button button--danger button--small' })
    const confirmDelete = button('Delete permanently', { className: 'button button--danger button--small' })
    const cancelDelete = button('Keep course', { className: 'button button--ghost button--small' })
    const confirmRow = h('div', { className: 'confirm-row' },
      h('span', { className: 'small', text: 'Deleting removes this course and its progress from this browser.' }),
      confirmDelete, cancelDelete)
    const root = h('div', { className: 'panel course-edit' },
      h('div', { className: 'field' }, h('label', { text: 'Course title', for: 'course-title' }), titleInput),
      h('div', { className: 'field' }, h('label', { text: 'Tags (comma separated)', for: 'course-tags' }), tagsInput),
      h('div', { className: 'button-row' }, save, cancel, remove),
      confirmRow)
    titleInput.id = 'course-title'
    tagsInput.id = 'course-tags'

    save.addEventListener('click', () => void saveCourseDetails(titleInput.value, tagsInput.value))
    cancel.addEventListener('click', () => { editing = false; confirmingDelete = false; update() })
    remove.addEventListener('click', () => { confirmingDelete = true; update() })
    cancelDelete.addEventListener('click', () => { confirmingDelete = false; update() })
    confirmDelete.addEventListener('click', () => void deleteCourse())
    return { root, titleInput, tagsInput, confirmRow }
  }

  // ------------------------------------------------------------------ render

  function recomputeModel(requestId = currentVideo?.videoId) {
    model = buildCourseViewModel(course, videos, { requestedVideoId: requestId, showRemoved, hideWatched })
    currentVideo = model.currentVideo
  }

  function update() {
    if (destroyed) return
    recomputeModel()

    setText(nodes.title, course.title)
    reconcileList(nodes.tags, course.tags ?? [], (tag) => tag,
      () => h('span', { className: 'tag' }), (node, tag) => setText(node, tag))

    nodes.bar.update(model.progress.percent, `${course.title}: ${model.progress.percent}% complete`)
    setText(nodes.caption, `${model.progress.watched} / ${model.progress.active} lessons completed · ${model.progress.percent}%`)

    setText(nodes.refreshButton, refreshing ? 'Refreshing…' : '↻ Refresh playlist')
    nodes.refreshButton.disabled = refreshing
    nodes.retryButton.hidden = !videos.some((v) => v.removedAt === undefined && !v.title)

    nodes.editPanel.root.hidden = !editing
    nodes.editPanel.confirmRow.hidden = !confirmingDelete
    nodes.editButton.setAttribute('aria-expanded', String(editing))
    if (editing && document.activeElement !== nodes.editPanel.titleInput
      && document.activeElement !== nodes.editPanel.tagsInput) {
      nodes.editPanel.titleInput.value = course.title
      nodes.editPanel.tagsInput.value = (course.tags ?? []).join(', ')
    }

    const hasLesson = Boolean(currentVideo)
    nodes.emptyNote.hidden = hasLesson
    nodes.playerColumn.hidden = !hasLesson
    // Hidden in its own right: while docked the actions sit outside the player
    // column, so hiding the column no longer takes them with it.
    nodes.playerActions.hidden = !hasLesson
    nodes.lessonPanel.hidden = !hasLesson

    if (hasLesson) {
      setText(nodes.watchedButton, currentVideo.watched ? '✓ Mark unwatched' : '✓ Mark as watched')
      setClass(nodes.watchedButton, currentVideo.watched ? 'button button--secondary' : 'button button--primary')
      nodes.youtubeLink.href = canonicalWatchUrl(currentVideo.videoId, course.playlistId)
      setText(nodes.lessonEyebrow, `Lesson ${currentVideo.position + 1}`)
      setText(nodes.lessonTitle, currentVideo.title ?? shortVideoLabel(currentVideo.videoId))
      const showResume = currentVideo.resumeSeconds > 1
      nodes.resumeHint.hidden = !showResume
      if (showResume) setText(nodes.resumeHint, `Resume at ${formatDuration(currentVideo.resumeSeconds)}`)
    }

    const hiddenNote = model.hiddenWatchedCount > 0 ? ` · ${model.hiddenWatchedCount} hidden` : ''
    setText(nodes.lessonCount, `${model.progress.watched} / ${model.progress.active} completed${hiddenNote}`)
    // Offering the filter before anything is complete would only be a control
    // that does nothing.
    nodes.watchedToggle.hidden = model.progress.watched === 0
    if (nodes.watchedToggleInput.checked !== hideWatched) nodes.watchedToggleInput.checked = hideWatched
    nodes.removedToggle.hidden = model.removedCount === 0
    if (nodes.removedToggleInput.checked !== showRemoved) nodes.removedToggleInput.checked = showRemoved
    renderLessons()

    nodes.summary.hidden = !refreshSummary
    if (refreshSummary) {
      setText(nodes.summary, `${refreshSummary.added} added · ${refreshSummary.removed} removed · ${refreshSummary.unchanged} unchanged`)
    }
    const duplicates = refreshSummary?.duplicateIds?.length ?? 0
    nodes.duplicateNote.hidden = duplicates === 0
    if (duplicates) {
      setText(nodes.duplicateNote, `YouTube returned ${duplicates} duplicate playlist ${duplicates === 1 ? 'entry' : 'entries'}; CourseTracker kept the first occurrence.`)
    }
  }

  function renderLessons() {
    reconcileList(nodes.lessonList, model.visibleVideos, (video) => video.videoId,
      () => {
        const row = h('button', { type: 'button', className: 'lesson-row' },
          h('span', { className: 'lesson-row__position' }),
          h('span', { className: 'lesson-row__title' }),
          h('span', { className: 'lesson-row__state' }))
        row.addEventListener('click', () => {
          const videoId = row.dataset.key
          const target = videos.find((v) => v.videoId === videoId)
          if (target?.removedAt !== undefined) {
            showToast('This lesson is no longer in the YouTube playlist.', 'info')
            return
          }
          void goToVideo(videoId)
        })
        return row
      },
      (row, video) => {
        const isRemoved = video.removedAt !== undefined
        const title = video.title ?? shortVideoLabel(video.videoId)
        const [position, titleNode, state] = row.children
        setClass(row, `lesson-row${video.videoId === currentVideo?.videoId ? ' lesson-row--active' : ''}${isRemoved ? ' lesson-row--removed' : ''}`)
        // Retired lessons carry no live sequence number, so they can never
        // duplicate an active one.
        setText(position, isRemoved ? '–' : String(video.position + 1))
        setText(titleNode, title)
        setText(state, isRemoved
          ? 'Removed'
          : video.watched ? '✓'
            : video.resumeSeconds > 0 ? `↻ ${formatDuration(video.resumeSeconds)}`
              : formatDuration(video.durationSeconds))
        setClass(state, `lesson-row__state${!isRemoved && video.watched ? ' lesson-row__check' : ''}`)
        row.setAttribute('aria-label', isRemoved
          ? `${title}, removed from the playlist`
          : `${video.position + 1}. ${title}${video.watched ? ', watched' : ''}`)
      })
  }

  // ------------------------------------------------------------------ player

  async function mountPlayerOnce() {
    if (!currentVideo || playerHandle) return
    playerMountedVideoId = currentVideo.videoId
    nodes.playerHost.replaceChildren()
    try {
      const handle = await mountPlayer(nodes.playerHost, {
        videoId: currentVideo.videoId,
        startSeconds: currentVideo.resumeSeconds ?? 0,
        onSnapshot: (snapshot) => { if (!destroyed) void flush(snapshot) },
        onEmbedStatus: (status) => { if (!destroyed) applyEmbedStatus(status) },
      })
      if (destroyed) handle?.destroy?.()
      else playerHandle = handle
    } catch (error) {
      console.warn('Player failed to initialize', error)
      if (!destroyed) {
        nodes.playerHost.replaceChildren(h('div', { className: 'player-placeholder', text: 'Embedded playback is unavailable. Use Open on YouTube below.' }))
      }
    }
  }

  function applyEmbedStatus(status) {
    if (!currentVideo) return
    const videoId = currentVideo.videoId
    void store.updateVideo(course.id, videoId, { embedStatus: status }).catch(() => {})
    nodes.warningHost.replaceChildren()
    if (status === 'restricted' || status === 'unavailable') {
      nodes.warningHost.append(h('div', { className: 'inline-error' },
        h('div', { text: "This lesson can't be played in an embedded player." }),
        h('a', {
          className: 'button button--secondary button--small', target: '_blank', rel: 'noreferrer',
          href: canonicalWatchUrl(videoId, course.playlistId), text: 'Open on YouTube',
        })))
    }
  }

  async function goToVideo(videoId, { updateUrl = true } = {}) {
    const target = videos.find((item) => item.videoId === videoId && item.removedAt === undefined)
    if (!target || target.videoId === currentVideo?.videoId) return
    await flush(playerHandle?.snapshot?.())

    currentVideo = target
    suppressAutoComplete = false
    const now = Date.now()
    course = { ...course, currentVideoId: videoId, lastOpenedAt: now, updatedAt: now }
    await store.updateCourse(course.id, { currentVideoId: videoId, lastOpenedAt: now, updatedAt: now })

    if (updateUrl) {
      history.replaceState(null, '', `#/course/${encodeURIComponent(course.id)}?video=${encodeURIComponent(videoId)}`)
    }
    update()

    // Reuse the live player rather than remounting: a fresh iframe would
    // interrupt playback and cost a full YouTube load.
    if (playerHandle) {
      playerMountedVideoId = videoId
      playerHandle.load(videoId, target.resumeSeconds ?? 0)
      nodes.warningHost.replaceChildren()
    } else {
      await mountPlayerOnce()
    }
  }

  // ---------------------------------------------------------------- progress

  async function flush(snapshot) {
    const decision = resolveProgressUpdate({ snapshot, video: currentVideo, suppressAutoComplete })
    if (!decision.persist) return

    // A backward seek means the viewer intends to rewatch, so a prior manual
    // unwatch no longer needs protecting.
    if (suppressAutoComplete && snapshot.duration > 0
      && snapshot.currentTime / snapshot.duration < 0.95) suppressAutoComplete = false

    const videoId = currentVideo.videoId
    currentVideo = { ...currentVideo, ...decision.patch }
    if (decision.durationSeconds) currentVideo.durationSeconds = decision.durationSeconds
    videos = videos.map((video) => (video.videoId === videoId ? currentVideo : video))

    try {
      await store.updateProgress(course.id, videoId, decision.patch)
      if (decision.durationSeconds) {
        await store.updateVideo(course.id, videoId, { durationSeconds: decision.durationSeconds })
      }
    } catch (error) {
      console.warn('Unable to persist player progress', error)
      // Silently failing to save is worse than the failure itself: the viewer
      // would keep watching and lose everything. Say it once per page visit.
      if (!warnedAboutStorage && !destroyed) {
        warnedAboutStorage = true
        showToast('CourseTracker can no longer save progress in this browser. Check your storage settings.', 'error')
      }
      return
    }
    // Auto-completion has to reach the screen; the DB alone is not feedback.
    if (decision.watchedChanged && !destroyed) update()
  }

  async function setWatched(watched) {
    if (!currentVideo) return
    await flush(playerHandle?.snapshot?.())
    if (!watched) suppressAutoComplete = true
    const patch = { watched, resumeSeconds: currentVideo.resumeSeconds ?? 0, progressUpdatedAt: Date.now() }
    await store.updateProgress(course.id, currentVideo.videoId, patch)
    currentVideo = { ...currentVideo, ...patch }
    videos = videos.map((video) => (video.videoId === currentVideo.videoId ? currentVideo : video))
    update()
  }

  // ------------------------------------------------------------------ course

  async function saveCourseDetails(rawTitle, rawTags) {
    const title = rawTitle.trim()
    if (!title) {
      showToast('A course needs a title.', 'error')
      return
    }
    const tags = parseTagInput(rawTags)
    const now = Date.now()
    await store.updateCourse(course.id, { title, tags, titleSource: 'user', metadataUpdatedAt: now, updatedAt: now })
    course = { ...course, title, tags, titleSource: 'user', metadataUpdatedAt: now, updatedAt: now }
    editing = false
    confirmingDelete = false
    update()
    showToast('Course details saved.', 'success')
  }

  async function deleteCourse() {
    const removedCourse = course
    const removedVideos = await store.getCourseVideos(course.id)
    await store.deleteCourse(course.id)
    showToast(`${removedCourse.title} deleted.`, 'info', {
      action: {
        label: 'Undo',
        onClick: () => {
          void store.restoreCourse(removedCourse, removedVideos)
            .then(() => { location.hash = `#/course/${encodeURIComponent(removedCourse.id)}` })
            .catch(() => showToast('Could not restore the course.', 'error'))
        },
      },
    })
    location.hash = '#/'
  }

  async function exportCourse() {
    const snapshot = await store.snapshot()
    const backup = createBackupFromSnapshot(snapshot, course.id)
    const slug = course.title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'course'
    downloadJson(backup, `course-tracker-${slug}.json`)
  }

  // ----------------------------------------------------------------- refresh

  async function enrichLessonDetails(targetVideos, { refreshView = false } = {}) {
    if (!targetVideos.length) return []
    const results = await runLimited(targetVideos, 4, async (video) => {
      const metadata = await enrichVideo(video.videoId)
      const patch = {
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.authorName ? { authorName: metadata.authorName } : {}),
        ...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
      }
      if (Object.keys(patch).length === 0) return false
      await store.updateVideo(course.id, video.videoId, patch)
      return Boolean(metadata.title)
    })
    if (refreshView && !destroyed) {
      videos = await store.getCourseVideos(course.id)
      const resolved = results.filter((result) => result.status === 'fulfilled' && result.value).length
      const unresolved = targetVideos.length - resolved
      if (resolved > 0) showToast(`${resolved} lesson ${resolved === 1 ? 'detail' : 'details'} updated.`, 'success')
      else if (unresolved > 0) showToast('Some lesson details are still unavailable. You can retry later.', 'info')
      update()
    }
    return results
  }

  async function retryLessonDetails() {
    const missing = videos.filter((video) => video.removedAt === undefined && !video.title)
    await enrichLessonDetails(missing, { refreshView: true })
  }

  async function refreshPlaylist() {
    if (refreshing) return
    refreshing = true
    await flush(playerHandle?.snapshot?.())
    update()
    try {
      const discovery = await discoverPlaylist(course.playlistId)
      const now = Date.now()
      const priorIds = new Set(videos.map((video) => video.videoId))
      const activeBefore = videos.filter((video) => video.removedAt === undefined).length
      const diff = diffPlaylist(videos, discovery.videoIds, now, course.id)

      if (isMassRemoval(diff.summary, activeBefore)) {
        // A partially loaded playlist looks exactly like a mass deletion, so
        // never apply one silently.
        pendingRefresh = { diff, now, priorIds, activeBefore }
        showMassRemovalConfirmation()
        return
      }
      await commitRefresh(diff, now, priorIds)
    } catch (error) {
      console.warn('Playlist refresh failed', error)
      showToast("CourseTracker couldn't read this playlist from YouTube. Check that the playlist is accessible and try again.", 'error')
    } finally {
      refreshing = false
      if (!destroyed) update()
    }
  }

  async function commitRefresh(diff, now, priorIds) {
    await store.applyRefresh(course.id, diff.videos, { lastRefreshedAt: now, updatedAt: now })
    course = { ...course, lastRefreshedAt: now, updatedAt: now }
    videos = [...diff.videos].sort((a, b) => a.position - b.position)
    refreshSummary = diff.summary
    update()
    const needingMetadata = videos.filter((video) => video.removedAt === undefined
      && (!priorIds.has(video.videoId) || !video.title))
    // refreshView so freshly fetched titles actually reach the screen.
    await enrichLessonDetails(needingMetadata, { refreshView: true })
  }

  function showMassRemovalConfirmation() {
    const { diff, activeBefore } = pendingRefresh
    const dialog = h('div', { className: 'panel confirm-panel', role: 'alertdialog', 'aria-label': 'Confirm a large change' },
      h('h2', { text: 'Confirm a large change' }),
      h('p', {
        className: 'muted',
        text: `This refresh would retire ${diff.summary.removed} of ${activeBefore} lessons. YouTube sometimes returns a partial playlist, which looks the same as a deletion. Your progress is kept either way, but retired lessons leave the active list.`,
      }),
      h('div', { className: 'button-row' },
        button('Keep my lessons', {
          className: 'button button--primary',
          onClick: () => { pendingRefresh = null; dialog.remove(); showToast('Refresh cancelled. Nothing changed.', 'info') },
        }),
        button('Apply the change', {
          className: 'button button--danger',
          onClick: () => {
            const { diff: d, now, priorIds } = pendingRefresh
            pendingRefresh = null
            dialog.remove()
            void commitRefresh(d, now, priorIds)
          },
        })))
    nodes.page.insertBefore(dialog, nodes.page.firstChild)
    dialog.scrollIntoView?.({ block: 'nearest' })
  }
}
