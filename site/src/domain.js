export const COMPLETION_THRESHOLD = 0.95

/** Removing more than this share of a course, and more than MIN, needs confirmation. */
export const MASS_REMOVAL_RATIO = 0.25
export const MASS_REMOVAL_MIN = 5

export function shouldAutoComplete({ currentTime, duration, ended }) {
  if (ended) return true
  if (!Number.isFinite(duration) || duration <= 0) return false
  return currentTime / duration >= COMPLETION_THRESHOLD
}

/**
 * Pure decision for a player snapshot: what should be persisted, and does the
 * screen need to change? Extracted from the course page so the riskiest logic
 * in the app is unit-testable.
 */
export function resolveProgressUpdate({ snapshot, video, suppressAutoComplete = false, now = Date.now() }) {
  if (!snapshot || !video) return { persist: false }
  if (snapshot.videoId !== video.videoId) return { persist: false }
  if (!['playing', 'paused', 'ended'].includes(snapshot.state)) return { persist: false }

  const autoComplete = !suppressAutoComplete && shouldAutoComplete({
    currentTime: snapshot.currentTime,
    duration: snapshot.duration,
    ended: snapshot.state === 'ended',
  })
  const watched = Boolean(video.watched) || autoComplete
  const resumeSeconds = Math.max(0, Number(snapshot.currentTime) || 0)
  const duration = Number.isFinite(snapshot.duration) && snapshot.duration > 0 ? snapshot.duration : undefined

  return {
    persist: true,
    watchedChanged: watched !== Boolean(video.watched),
    patch: { watched, resumeSeconds, progressUpdatedAt: now },
    durationSeconds: duration !== undefined && duration !== video.durationSeconds ? duration : undefined,
  }
}

export function calculateCourseProgress(videos) {
  const activeVideos = videos.filter((video) => video.removedAt === undefined)
  const watched = activeVideos.filter((video) => video.watched).length
  const active = activeVideos.length
  const percent = active === 0 ? 0 : Math.round((watched / active) * 100)
  return { watched, active, percent }
}

export function selectContinueVideo(videos, currentVideoId) {
  const active = [...videos]
    .filter((video) => video.removedAt === undefined)
    .sort((a, b) => a.position - b.position)

  const currentIndex = active.findIndex((video) => video.videoId === currentVideoId)
  if (currentIndex >= 0 && !active[currentIndex].watched) return active[currentIndex]
  if (currentIndex >= 0) {
    const after = active.slice(currentIndex + 1).find((video) => !video.watched)
    if (after) return after
  }
  return active.find((video) => !video.watched) ?? active[currentIndex] ?? active[0]
}

function tagKey(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function normalizeTags(tags) {
  const values = new Map()
  for (const raw of tags) {
    const display = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!display) continue
    const key = tagKey(display)
    if (values.has(key)) values.delete(key)
    values.set(key, display)
  }
  return [...values.values()]
}

export function parseTagInput(text) {
  return normalizeTags(String(text ?? '').split(',').map((tag) => tag.trim()))
}

export function matchesSelectedTags(courseTags, selectedTags) {
  const courseKeys = new Set(courseTags.map(tagKey))
  return selectedTags.every((tag) => courseKeys.has(tagKey(tag)))
}

export function filterCourses(courses, filter) {
  const q = filter.query.trim().toLocaleLowerCase()
  const result = courses.filter((course) => {
    const progress = filter.progressByCourseId.get(course.id) ?? { watched: 0, active: 0, percent: 0 }
    const searchable = [course.title, course.authorName ?? '', ...(course.tags ?? [])].join(' ').toLocaleLowerCase()
    const statusMatches = filter.status === 'all'
      || (filter.status === 'completed' && progress.active > 0 && progress.percent === 100)
      || (filter.status === 'in-progress' && progress.active > 0 && progress.percent < 100)
    return (!q || searchable.includes(q))
      && matchesSelectedTags(course.tags ?? [], filter.selectedTags)
      && statusMatches
  })

  return result.sort((a, b) => {
    const pa = filter.progressByCourseId.get(a.id)?.percent ?? 0
    const pb = filter.progressByCourseId.get(b.id)?.percent ?? 0
    if (filter.sort === 'title') return a.title.localeCompare(b.title)
    if (filter.sort === 'progress') return pb - pa
    return (b.lastOpenedAt ?? b.updatedAt ?? 0) - (a.lastOpenedAt ?? a.updatedAt ?? 0)
  })
}

export function diffPlaylist(existing, discoveredIds, now, courseId = existing[0]?.courseId ?? '') {
  const seen = new Set()
  const duplicateIds = []
  const orderedIds = discoveredIds.filter((id) => {
    if (seen.has(id)) {
      duplicateIds.push(id)
      return false
    }
    seen.add(id)
    return true
  })

  const existingById = new Map(existing.map((video) => [video.videoId, video]))
  let added = 0
  let unchanged = 0
  const active = orderedIds.map((videoId, position) => {
    const prior = existingById.get(videoId)
    if (prior) {
      unchanged += 1
      const { removedAt: _removedAt, ...rest } = prior
      return { ...rest, position, lastSeenAt: now }
    }
    added += 1
    return {
      courseId,
      videoId,
      position,
      watched: false,
      resumeSeconds: 0,
      progressUpdatedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      embedStatus: 'unknown',
    }
  })

  let removed = 0
  // Retired lessons keep their history but are moved out of the active number
  // range so they can never collide with a live lesson's position.
  const historical = existing
    .filter((video) => !seen.has(video.videoId))
    .map((video) => {
      const archivedPosition = video.removedAt === undefined
        ? video.position
        : (video.archivedPosition ?? video.position)
      if (video.removedAt === undefined) removed += 1
      return {
        ...video,
        archivedPosition,
        position: Number.MAX_SAFE_INTEGER - 1,
        removedAt: video.removedAt ?? now,
      }
    })
    .sort((a, b) => (a.archivedPosition ?? 0) - (b.archivedPosition ?? 0))
    .map((video, index) => ({ ...video, position: orderedIds.length + index }))

  return {
    videos: [...active, ...historical],
    summary: { added, removed, unchanged, duplicateIds },
  }
}

/**
 * A refresh that retires a large share of a course is more likely to be a
 * partially loaded playlist than a real edit, so it needs confirmation.
 */
export function isMassRemoval(summary, activeCountBefore) {
  if (summary.removed <= MASS_REMOVAL_MIN) return false
  if (activeCountBefore <= 0) return false
  return summary.removed > activeCountBefore * MASS_REMOVAL_RATIO
}

export function selectNextUnwatched(videos, currentVideoId) {
  const active = [...videos]
    .filter((video) => video.removedAt === undefined)
    .sort((a, b) => a.position - b.position)
  if (active.length === 0) return undefined
  const currentIndex = active.findIndex((video) => video.videoId === currentVideoId)
  const start = currentIndex >= 0 ? currentIndex + 1 : 0
  for (let offset = 0; offset < active.length; offset += 1) {
    const candidate = active[(start + offset) % active.length]
    if (!candidate.watched && candidate.videoId !== currentVideoId) return candidate
  }
  return undefined
}
