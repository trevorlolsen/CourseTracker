import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCourseProgress,
  diffPlaylist,
  filterCourses,
  matchesSelectedTags,
  normalizeTags,
  selectContinueVideo,
  shouldAutoComplete,
} from '../site/src/domain.js'

const video = (videoId, position, watched = false, removedAt) => ({
  courseId: 'c1', videoId, position, watched, removedAt, resumeSeconds: watched ? 33 : 0,
  progressUpdatedAt: 10, firstSeenAt: 1, lastSeenAt: 2, embedStatus: 'unknown',
})

test('auto completion uses 95 percent or ended', () => {
  assert.equal(shouldAutoComplete({ currentTime: 94.9, duration: 100, ended: false }), false)
  assert.equal(shouldAutoComplete({ currentTime: 95, duration: 100, ended: false }), true)
  assert.equal(shouldAutoComplete({ currentTime: 0, duration: 0, ended: true }), true)
})

test('course progress excludes removed lessons', () => {
  assert.deepEqual(calculateCourseProgress([video('a', 0, true), video('b', 1), video('old', 2, false, 99)]), {
    watched: 1, active: 2, percent: 50,
  })
})

test('continue advances past a watched current lesson', () => {
  assert.equal(selectContinueVideo([video('a', 0, true), video('b', 1), video('c', 2)], 'a').videoId, 'b')
})

test('tags dedupe case-insensitively and keep most recent casing', () => {
  assert.deepEqual(normalizeTags([' Rust ', 'WEB dev', 'rust']), ['WEB dev', 'rust'])
  assert.equal(matchesSelectedTags(['Rust', 'Beginner'], ['rust', 'BEGINNER']), true)
  assert.equal(matchesSelectedTags(['Rust'], ['Rust', 'Beginner']), false)
})

test('library filtering matches title and AND tags', () => {
  const courses = [
    { id: 'r', title: 'Rust Fundamentals', authorName: '', tags: ['Systems', 'Beginner'], updatedAt: 2 },
    { id: 's', title: 'Statistics', authorName: '', tags: ['Math'], updatedAt: 1 },
  ]
  const progress = new Map([['r', { watched: 1, active: 2, percent: 50 }], ['s', { watched: 0, active: 2, percent: 0 }]])
  assert.deepEqual(filterCourses(courses, { query: 'rust', selectedTags: ['systems', 'beginner'], status: 'all', sort: 'title', progressByCourseId: progress }).map(x => x.id), ['r'])
})

test('playlist diff preserves progress, removes missing, reactivates returning, and rejects duplicate ordering', () => {
  const result = diffPlaylist([video('keep', 0, true), video('gone', 1), video('back', 2, false, 5)], ['back', 'keep', 'new', 'keep'], 100, 'c1')
  assert.deepEqual(result.summary, { added: 1, removed: 1, unchanged: 2, duplicateIds: ['keep'] })
  assert.deepEqual(Object.fromEntries(result.videos.map(v => [v.videoId, v])).keep.watched, true)
  assert.equal(Object.fromEntries(result.videos.map(v => [v.videoId, v])).keep.resumeSeconds, 33)
  assert.equal(Object.fromEntries(result.videos.map(v => [v.videoId, v])).back.removedAt, undefined)
  assert.equal(Object.fromEntries(result.videos.map(v => [v.videoId, v])).gone.removedAt, 100)
})

import { selectNextUnwatched } from '../site/src/domain.js'

test('next unwatched skips the current lesson and wraps to earlier unwatched lessons', () => {
  const videos = [video('a', 0, false), video('b', 1, true), video('c', 2, false)]
  assert.equal(selectNextUnwatched(videos, 'a').videoId, 'c')
  assert.equal(selectNextUnwatched(videos, 'c').videoId, 'a')
})
