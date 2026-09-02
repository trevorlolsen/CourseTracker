import { calculateCourseProgress, filterCourses, normalizeTags, selectContinueVideo } from './domain.js'
import { parsePlaylistId } from './youtube.js'

export function buildLibraryViewModel(courses, videosByCourseId, filters) {
  const progressByCourseId = new Map()
  const cards = courses.map((course) => {
    const videos = videosByCourseId.get(course.id) ?? []
    const progress = calculateCourseProgress(videos)
    progressByCourseId.set(course.id, progress)
    const current = selectContinueVideo(videos, course.currentVideoId)
    return { course, videos, progress, current }
  })

  const continueCourses = cards
    .filter(({ progress }) => progress.active > 0 && progress.percent < 100)
    .sort((a, b) => (b.course.lastOpenedAt ?? b.course.updatedAt ?? 0) - (a.course.lastOpenedAt ?? a.course.updatedAt ?? 0))
    .slice(0, 4)

  const filtered = filterCourses(courses, { ...filters, progressByCourseId })
  const byId = new Map(cards.map((card) => [card.course.id, card]))
  const allCourses = filtered.map((course) => byId.get(course.id))
  const allTags = normalizeTags(courses.flatMap((course) => course.tags ?? [])).sort((a, b) => a.localeCompare(b))
  return { continueCourses, allCourses, allTags, progressByCourseId }
}

export function buildCourseViewModel(course, videos, { requestedVideoId, showRemoved }) {
  const ordered = [...videos].sort((a, b) => a.position - b.position)
  const active = ordered.filter((video) => video.removedAt === undefined)
  // Retired lessons are a separate list so their historic numbering can never
  // collide with the live sequence.
  const removed = ordered
    .filter((video) => video.removedAt !== undefined)
    .sort((a, b) => (a.archivedPosition ?? a.position) - (b.archivedPosition ?? b.position))
  const requested = active.find((video) => video.videoId === requestedVideoId)
  const current = requested ?? selectContinueVideo(active, course.currentVideoId) ?? active[0]
  return {
    progress: calculateCourseProgress(ordered),
    currentVideo: current,
    activeVideos: active,
    removedVideos: removed,
    visibleVideos: showRemoved ? [...active, ...removed] : active,
    removedCount: removed.length,
  }
}

export function parsePlaylistInputs(text) {
  const lines = String(text ?? '').split(/[\r\n,;]+/).map((line) => line.trim()).filter(Boolean)
  const valid = []
  const invalid = []
  const seen = new Set()
  for (const rawUrl of lines) {
    const playlistId = parsePlaylistId(rawUrl)
    if (!playlistId) {
      invalid.push(rawUrl)
      continue
    }
    if (seen.has(playlistId)) continue
    seen.add(playlistId)
    valid.push({ rawUrl, playlistId })
  }
  return { valid, invalid }
}
