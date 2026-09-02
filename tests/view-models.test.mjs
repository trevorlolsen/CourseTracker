import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCourseViewModel, buildLibraryViewModel, parsePlaylistInputs } from '../site/src/view-models.js'

const course = (id, title, tags, lastOpenedAt = 0) => ({
  id, playlistId: `PL_${id}`, sourceUrl: '', title, titleSource: 'user', tags,
  createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1, lastOpenedAt,
})
const video = (courseId, videoId, position, watched = false, removedAt) => ({
  courseId, videoId, position, title: `${videoId} title`, watched, removedAt, resumeSeconds: 0,
  progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown',
})

test('library model limits Continue Learning to four recent incomplete courses', () => {
  const courses = [1,2,3,4,5].map((n) => course(`c${n}`, `Course ${n}`, ['Tag'], n))
  const videosByCourseId = new Map(courses.map((c) => [c.id, [video(c.id, `${c.id}-v`, 0, false)]]))
  const model = buildLibraryViewModel(courses, videosByCourseId, { query: '', selectedTags: [], status: 'all', sort: 'recent' })
  assert.deepEqual(model.continueCourses.map((x) => x.course.id), ['c5', 'c4', 'c3', 'c2'])
  assert.equal(model.allCourses.length, 5)
})

test('course model honors requested lesson and hides removed lessons by default', () => {
  const c = { ...course('c1', 'Rust', ['Rust']), currentVideoId: 'v1' }
  const videos = [video('c1', 'v1', 0, true), video('c1', 'v2', 1), video('c1', 'old', 2, false, 99)]
  const model = buildCourseViewModel(c, videos, { requestedVideoId: 'v2', showRemoved: false })
  assert.equal(model.currentVideo.videoId, 'v2')
  assert.deepEqual(model.visibleVideos.map((v) => v.videoId), ['v1', 'v2'])
  assert.deepEqual(model.progress, { watched: 1, active: 2, percent: 50 })
})

test('playlist input parser keeps one item per playlist id and reports invalid lines', () => {
  const parsed = parsePlaylistInputs(`https://youtube.com/playlist?list=PL1\nnope\nhttps://youtu.be/x?list=PL1\nhttps://youtube.com/playlist?list=PL2`)
  assert.deepEqual(parsed.valid.map((x) => x.playlistId), ['PL1', 'PL2'])
  assert.deepEqual(parsed.invalid, ['nope'])
})

test('course model has no current lesson when every stored lesson is removed', () => {
  const course = { id: 'c1', currentVideoId: 'v1' }
  const videos = [
    { courseId: 'c1', videoId: 'v1', position: 0, watched: true, removedAt: 10 },
    { courseId: 'c1', videoId: 'v2', position: 1, watched: false, removedAt: 10 },
  ]

  const model = buildCourseViewModel(course, videos, { showRemoved: false })
  assert.equal(model.currentVideo, undefined)
  assert.deepEqual(model.visibleVideos, [])
  assert.equal(model.removedCount, 2)
})
