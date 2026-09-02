import { normalizeTags } from './domain.js'
import { isValidPlaylistId, isValidVideoId, safeThumbnailUrl } from './youtube.js'

/** Shared ceiling for any file a user hands to an importer. */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024

// Free-text fields are capped rather than rejected. A legitimate backup never
// comes close, and a hostile one should not get to park megabytes in a title.
const MAX_TITLE_LENGTH = 500
const MAX_AUTHOR_LENGTH = 200
const MAX_TAG_LENGTH = 100
const MAX_TAGS = 50

function requiredObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value
}

function requiredString(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function boundedString(value, label, max) {
  return requiredString(value, label).slice(0, max)
}

function optionalString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/** `{ key: value }` when defined, otherwise nothing, for spreading. */
function optional(key, value) {
  return value === undefined ? {} : { [key]: value }
}

function requiredNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

/** Non-negative, finite, and rounded where an integer is required. */
function boundedNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const number = requiredNumber(value, label)
  if (number < min || number > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return integer ? Math.round(number) : number
}

function requiredTimestamp(value, label) {
  const parsed = Date.parse(value)
  if (typeof value !== 'string' || Number.isNaN(parsed)) {
    throw new Error(`${label} must be an ISO date string`)
  }
  return value
}

function requiredVideoId(value) {
  const id = requiredString(value, 'videoId')
  if (!isValidVideoId(id)) throw new Error('videoId contains unsupported characters')
  return id
}

function requiredPlaylistId(value) {
  const id = requiredString(value, 'playlistId')
  if (!isValidPlaylistId(id)) throw new Error('playlistId contains unsupported characters')
  return id
}

/** Optional ID references are dropped, not fatal: they only steer the UI. */
function optionalVideoId(value) {
  return isValidVideoId(value) ? value : undefined
}

/**
 * Only https YouTube URLs survive. Nothing renders sourceUrl as a link today,
 * but storing an unvalidated URL is a trap for whoever adds that link later.
 */
function safeSourceUrl(value) {
  const raw = requiredString(value ?? '', 'sourceUrl')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname)) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function parseVideo(video) {
  requiredObject(video, 'Backup video must be an object')
  const embedStatus = video.embedStatus ?? 'unknown'
  if (!['unknown', 'playable', 'unavailable', 'restricted'].includes(embedStatus)) throw new Error('Invalid embed status')
  return {
    videoId: requiredVideoId(video.videoId),
    position: boundedNumber(video.position, 'position', { min: 0, max: 100000, integer: true }),
    ...optional('title', optionalString(video.title, MAX_TITLE_LENGTH)),
    ...optional('authorName', optionalString(video.authorName, MAX_AUTHOR_LENGTH)),
    ...optional('thumbnailUrl', safeThumbnailUrl(video.thumbnailUrl)),
    ...(typeof video.durationSeconds === 'number' && Number.isFinite(video.durationSeconds) && video.durationSeconds >= 0
      ? { durationSeconds: video.durationSeconds } : {}),
    watched: Boolean(video.watched),
    resumeSeconds: boundedNumber(video.resumeSeconds ?? 0, 'resumeSeconds', { max: 86400 * 7 }),
    progressUpdatedAt: boundedNumber(video.progressUpdatedAt ?? 0, 'progressUpdatedAt'),
    firstSeenAt: boundedNumber(video.firstSeenAt ?? 0, 'firstSeenAt'),
    lastSeenAt: boundedNumber(video.lastSeenAt ?? 0, 'lastSeenAt'),
    ...(typeof video.removedAt === 'number' && Number.isFinite(video.removedAt)
      ? { removedAt: Math.max(0, video.removedAt) } : {}),
    ...(typeof video.archivedPosition === 'number' && Number.isFinite(video.archivedPosition)
      ? { archivedPosition: Math.max(0, Math.round(video.archivedPosition)) } : {}),
    embedStatus,
  }
}

function parseCourse(course) {
  requiredObject(course, 'Backup course must be an object')
  if (!Array.isArray(course.videos)) throw new Error('Backup course videos must be an array')
  const titleSource = course.titleSource ?? 'fallback'
  if (!['youtube', 'user', 'fallback'].includes(titleSource)) throw new Error('Invalid title source')
  return {
    playlistId: requiredPlaylistId(course.playlistId),
    sourceUrl: safeSourceUrl(course.sourceUrl ?? ''),
    title: boundedString(course.title, 'title', MAX_TITLE_LENGTH),
    titleSource,
    ...optional('authorName', optionalString(course.authorName, MAX_AUTHOR_LENGTH)),
    ...optional('thumbnailVideoId', optionalVideoId(course.thumbnailVideoId)),
    tags: normalizeTags(Array.isArray(course.tags)
      ? course.tags.map((tag) => String(tag).slice(0, MAX_TAG_LENGTH))
      : []).slice(0, MAX_TAGS),
    ...optional('currentVideoId', optionalVideoId(course.currentVideoId)),
    createdAt: boundedNumber(course.createdAt ?? 0, 'createdAt'),
    updatedAt: boundedNumber(course.updatedAt ?? 0, 'updatedAt'),
    metadataUpdatedAt: boundedNumber(course.metadataUpdatedAt ?? 0, 'metadataUpdatedAt'),
    ...(typeof course.lastOpenedAt === 'number' && Number.isFinite(course.lastOpenedAt)
      ? { lastOpenedAt: Math.max(0, course.lastOpenedAt) } : {}),
    ...(typeof course.lastRefreshedAt === 'number' && Number.isFinite(course.lastRefreshedAt)
      ? { lastRefreshedAt: Math.max(0, course.lastRefreshedAt) } : {}),
    videos: course.videos.map(parseVideo),
  }
}

export function parseBackup(input) {
  const root = requiredObject(input, 'Backup must be an object')
  if (root.schemaVersion !== 1) throw new Error(`Unsupported backup schema version: ${String(root.schemaVersion)}`)
  if (!Array.isArray(root.courses)) throw new Error('Backup courses must be an array')
  const courses = root.courses.map(parseCourse)

  const playlistIds = new Set()
  for (const course of courses) {
    if (playlistIds.has(course.playlistId)) {
      throw new Error(`Backup contains two courses for playlist ${course.playlistId}`)
    }
    playlistIds.add(course.playlistId)
    const videoIds = new Set()
    for (const video of course.videos) {
      if (videoIds.has(video.videoId)) {
        throw new Error(`Backup course ${course.playlistId} lists video ${video.videoId} twice`)
      }
      videoIds.add(video.videoId)
    }
  }

  return {
    schemaVersion: 1,
    exportedAt: requiredTimestamp(root.exportedAt, 'exportedAt'),
    courses,
  }
}

/** Historical name; v1 is still the only schema, so there is nothing to migrate. */
export const parseAndMigrateBackup = parseBackup

export function remapBackupForReplace(input, uuid = () => crypto.randomUUID()) {
  const backup = parseBackup(input)
  const courses = []
  const videos = []
  for (const incoming of backup.courses) {
    const id = uuid()
    const { videos: incomingVideos, ...course } = incoming
    courses.push({ ...course, id })
    videos.push(...incomingVideos.map((video) => ({ ...video, courseId: id })))
  }
  return { courses, videos }
}

export function mergeBackupData(local, input, uuid = () => crypto.randomUUID()) {
  const backup = parseBackup(input)
  const courses = [...local.courses.map((course) => ({ ...course, tags: [...(course.tags ?? [])] }))]
  const videos = [...local.videos.map((video) => ({ ...video }))]
  const courseByPlaylist = new Map(courses.map((course) => [course.playlistId, course]))

  for (const incoming of backup.courses) {
    let localCourse = courseByPlaylist.get(incoming.playlistId)
    if (!localCourse) {
      const id = uuid()
      const { videos: incomingVideos, ...course } = incoming
      localCourse = { ...course, id }
      courses.push(localCourse)
      courseByPlaylist.set(localCourse.playlistId, localCourse)
      videos.push(...incomingVideos.map((video) => ({ ...video, courseId: id })))
      continue
    }

    const localStructureUpdatedAt = localCourse.updatedAt ?? 0
    const incomingStructureUpdatedAt = incoming.updatedAt ?? 0
    const incomingStructureWins = incomingStructureUpdatedAt > localStructureUpdatedAt
    const incomingMetadataWins = (incoming.metadataUpdatedAt ?? 0) > (localCourse.metadataUpdatedAt ?? 0)
    const localLastOpenedAt = localCourse.lastOpenedAt ?? 0
    const incomingLastOpenedAt = incoming.lastOpenedAt ?? 0

    if (incomingMetadataWins) {
      localCourse.title = incoming.title
      localCourse.titleSource = incoming.titleSource
      localCourse.tags = [...incoming.tags]
      localCourse.metadataUpdatedAt = incoming.metadataUpdatedAt
      if (incoming.authorName !== undefined) localCourse.authorName = incoming.authorName
      else delete localCourse.authorName
      if (incoming.thumbnailVideoId !== undefined) localCourse.thumbnailVideoId = incoming.thumbnailVideoId
      else delete localCourse.thumbnailVideoId
    }

    if (incomingStructureWins) localCourse.sourceUrl = incoming.sourceUrl
    if (incomingLastOpenedAt > localLastOpenedAt && incoming.currentVideoId !== undefined) {
      localCourse.currentVideoId = incoming.currentVideoId
    }
    localCourse.createdAt = Math.min(localCourse.createdAt ?? incoming.createdAt, incoming.createdAt)
    localCourse.updatedAt = Math.max(localStructureUpdatedAt, incomingStructureUpdatedAt)
    if (localLastOpenedAt || incomingLastOpenedAt) localCourse.lastOpenedAt = Math.max(localLastOpenedAt, incomingLastOpenedAt)
    const localLastRefreshedAt = localCourse.lastRefreshedAt ?? 0
    const incomingLastRefreshedAt = incoming.lastRefreshedAt ?? 0
    if (localLastRefreshedAt || incomingLastRefreshedAt) {
      localCourse.lastRefreshedAt = Math.max(localLastRefreshedAt, incomingLastRefreshedAt)
    }

    const localVideos = videos.filter((video) => video.courseId === localCourse.id)
    const byId = new Map(localVideos.map((video) => [video.videoId, video]))
    for (const incomingVideo of incoming.videos) {
      const current = byId.get(incomingVideo.videoId)
      if (!current) {
        const inserted = { ...incomingVideo, courseId: localCourse.id }
        videos.push(inserted)
        byId.set(incomingVideo.videoId, inserted)
        continue
      }
      const progressWinner = incomingVideo.progressUpdatedAt > (current.progressUpdatedAt ?? 0) ? incomingVideo : current
      const structureWinner = incomingStructureWins ? incomingVideo : current
      Object.assign(current, {
        ...structureWinner,
        courseId: localCourse.id,
        watched: progressWinner.watched,
        resumeSeconds: progressWinner.resumeSeconds,
        progressUpdatedAt: progressWinner.progressUpdatedAt,
      })
      if (incomingStructureWins && incomingVideo.removedAt === undefined) delete current.removedAt
    }
  }

  return { courses, videos }
}

export function createBackupFromSnapshot(snapshot, courseId, now = new Date()) {
  const selectedCourses = courseId
    ? snapshot.courses.filter((course) => course.id === courseId)
    : snapshot.courses
  return {
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    courses: selectedCourses.map((course) => {
      const { id, ...portableCourse } = course
      const courseVideos = snapshot.videos
        .filter((video) => video.courseId === id)
        .sort((a, b) => a.position - b.position)
        .map((video) => {
          const { courseId: _courseId, ...portableVideo } = video
          return portableVideo
        })
      return { ...portableCourse, videos: courseVideos }
    }),
  }
}
