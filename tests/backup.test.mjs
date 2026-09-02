import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BACKUP_BYTES, mergeBackupData, parseAndMigrateBackup, parseBackup, remapBackupForReplace,
} from '../site/src/backup.js'

const backup = {
  schemaVersion: 1,
  exportedAt: '2026-09-02T00:00:00.000Z',
  courses: [{
    playlistId: 'PL1', sourceUrl: '', title: 'Incoming', titleSource: 'user', tags: ['Rust'],
    createdAt: 1, updatedAt: 2, metadataUpdatedAt: 600, currentVideoId: 'v1',
    videos: [{ videoId: 'v1', position: 0, watched: true, resumeSeconds: 88, progressUpdatedAt: 500, firstSeenAt: 1, lastSeenAt: 2, embedStatus: 'unknown' }],
  }],
}

test('backup parser accepts v1 and rejects unsupported versions', () => {
  assert.equal(parseAndMigrateBackup(backup).schemaVersion, 1)
  assert.throws(() => parseAndMigrateBackup({ ...backup, schemaVersion: 2 }), /unsupported backup schema version/i)
})

function withCourse(patch) {
  return { ...backup, courses: [{ ...backup.courses[0], ...patch }] }
}
const video = backup.courses[0].videos[0]

test('backup parser rejects malformed identifiers', () => {
  assert.throws(() => parseBackup(withCourse({ playlistId: 'PL<script>' })), /playlistId/)
  assert.throws(() => parseBackup(withCourse({ playlistId: '' })), /playlistId/)
  assert.throws(() => parseBackup(withCourse({ videos: [{ ...video, videoId: '../x' }] })), /videoId/)
})

test('backup parser drops unsafe optional references instead of storing them', () => {
  const hostile = parseBackup(withCourse({
    thumbnailVideoId: 'javascript:x',
    currentVideoId: 'a b',
    videos: [{ ...video, thumbnailUrl: 'javascript:alert(1)' }],
  }))
  assert.equal(hostile.courses[0].thumbnailVideoId, undefined)
  assert.equal(hostile.courses[0].currentVideoId, undefined)
  assert.equal(hostile.courses[0].videos[0].thumbnailUrl, undefined)

  const clean = parseBackup(withCourse({
    thumbnailVideoId: 'v1',
    videos: [{ ...video, thumbnailUrl: 'https://i.ytimg.com/vi/v1/hqdefault.jpg' }],
  }))
  assert.equal(clean.courses[0].thumbnailVideoId, 'v1')
  assert.equal(clean.courses[0].currentVideoId, 'v1')
  assert.equal(clean.courses[0].videos[0].thumbnailUrl, 'https://i.ytimg.com/vi/v1/hqdefault.jpg')
})

test('backup parser caps free-text lengths and tag counts', () => {
  const parsed = parseBackup(withCourse({
    title: 'x'.repeat(10_000),
    authorName: 'y'.repeat(10_000),
    tags: Array.from({ length: 200 }, (_, i) => `tag${i}${'z'.repeat(500)}`),
    videos: [{ ...video, title: 'v'.repeat(10_000), authorName: 'w'.repeat(10_000) }],
  }))
  const course = parsed.courses[0]
  assert.equal(course.title.length, 500)
  assert.equal(course.authorName.length, 200)
  assert.equal(course.tags.length, 50)
  assert.ok(course.tags.every((tag) => tag.length <= 100))
  assert.equal(course.videos[0].title.length, 500)
  assert.equal(course.videos[0].authorName.length, 200)
  assert.ok(MAX_BACKUP_BYTES >= 1_000_000, 'the shared import cap must not be smaller than the old playlist-list cap')
})

test('merge uses playlist/video identity and newest timestamps', () => {
  const local = {
    courses: [{ id: 'local1', playlistId: 'PL1', sourceUrl: '', title: 'Old', titleSource: 'user', tags: ['Old'], createdAt: 1, updatedAt: 1, metadataUpdatedAt: 100 }],
    videos: [{ courseId: 'local1', videoId: 'v1', position: 0, watched: false, resumeSeconds: 5, progressUpdatedAt: 100, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown' }],
  }
  const merged = mergeBackupData(local, backup, () => 'new-id')
  assert.equal(merged.courses[0].id, 'local1')
  assert.equal(merged.courses[0].title, 'Incoming')
  assert.deepEqual(merged.courses[0].tags, ['Rust'])
  assert.equal(merged.videos[0].watched, true)
  assert.equal(merged.videos[0].resumeSeconds, 88)
})

test('replace remaps local ids and courseId fields', () => {
  const replaced = remapBackupForReplace(backup, () => 'fresh')
  assert.equal(replaced.courses[0].id, 'fresh')
  assert.equal(replaced.videos[0].courseId, 'fresh')
})

import { createBackupFromSnapshot } from '../site/src/backup.js'

test('backup export omits local ids and can export one course', () => {
  const snapshot = {
    courses: [
      { id: 'c1', playlistId: 'PL1', sourceUrl: '', title: 'One', titleSource: 'user', tags: [], createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1 },
      { id: 'c2', playlistId: 'PL2', sourceUrl: '', title: 'Two', titleSource: 'user', tags: [], createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1 },
    ],
    videos: [
      { courseId: 'c1', videoId: 'v1', position: 0, watched: false, resumeSeconds: 0, progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown' },
      { courseId: 'c2', videoId: 'v2', position: 0, watched: false, resumeSeconds: 0, progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown' },
    ],
  }
  const exported = createBackupFromSnapshot(snapshot, 'c2', new Date('2026-09-02T12:00:00Z'))
  assert.equal(exported.courses.length, 1)
  assert.equal(exported.courses[0].playlistId, 'PL2')
  assert.equal(exported.courses[0].id, undefined)
  assert.equal(exported.courses[0].videos[0].courseId, undefined)
})

test('merge assigns a new local id to an unknown playlist', () => {
  const incoming = { ...backup, courses: [{ ...backup.courses[0], playlistId: 'PL_NEW' }] }
  const merged = mergeBackupData({ courses: [], videos: [] }, incoming, () => 'fresh-id')
  assert.equal(merged.courses[0].id, 'fresh-id')
  assert.equal(merged.videos[0].courseId, 'fresh-id')
})

test('merge takes newer playlist structure while keeping newer local progress', () => {
  const local = {
    courses: [{ id: 'c1', playlistId: 'PL1', sourceUrl: 'local', title: 'Local', titleSource: 'user', tags: ['Local'], createdAt: 1, updatedAt: 100, metadataUpdatedAt: 700, lastOpenedAt: 100 }],
    videos: [
      { courseId: 'c1', videoId: 'v1', position: 0, watched: true, resumeSeconds: 50, progressUpdatedAt: 900, firstSeenAt: 1, lastSeenAt: 100, embedStatus: 'playable' },
      { courseId: 'c1', videoId: 'old', position: 1, watched: false, resumeSeconds: 0, progressUpdatedAt: 100, firstSeenAt: 1, lastSeenAt: 100, embedStatus: 'unknown' },
    ],
  }
  const incoming = {
    schemaVersion: 1, exportedAt: '2026-09-02T00:00:00.000Z',
    courses: [{
      playlistId: 'PL1', sourceUrl: 'incoming', title: 'Incoming stale metadata', titleSource: 'youtube', tags: ['Incoming'],
      createdAt: 1, updatedAt: 800, metadataUpdatedAt: 600, lastOpenedAt: 500,
      videos: [
        { videoId: 'v1', position: 1, watched: false, resumeSeconds: 10, progressUpdatedAt: 500, firstSeenAt: 1, lastSeenAt: 800, embedStatus: 'playable' },
        { videoId: 'old', position: 2, watched: false, resumeSeconds: 0, progressUpdatedAt: 100, firstSeenAt: 1, lastSeenAt: 800, removedAt: 800, embedStatus: 'unknown' },
      ],
    }],
  }
  const merged = mergeBackupData(local, incoming, () => 'unused')
  const course = merged.courses[0]
  const byId = new Map(merged.videos.map((v) => [v.videoId, v]))
  assert.equal(course.title, 'Local')
  assert.deepEqual(course.tags, ['Local'])
  assert.equal(course.updatedAt, 800)
  assert.equal(byId.get('v1').position, 1)
  assert.equal(byId.get('v1').watched, true)
  assert.equal(byId.get('v1').resumeSeconds, 50)
  assert.equal(byId.get('old').removedAt, 800)
})

test('merge reactivates a lesson when the newer playlist structure contains it as active', () => {
  const local = {
    courses: [{ id: 'c1', playlistId: 'PL1', sourceUrl: 'local', title: 'Local', titleSource: 'user', tags: [], createdAt: 1, updatedAt: 100, metadataUpdatedAt: 100 }],
    videos: [{ courseId: 'c1', videoId: 'v1', position: 4, watched: true, resumeSeconds: 33, progressUpdatedAt: 900, firstSeenAt: 1, lastSeenAt: 100, removedAt: 100, embedStatus: 'playable' }],
  }
  const incoming = {
    schemaVersion: 1, exportedAt: '2026-09-02T00:00:00.000Z',
    courses: [{
      playlistId: 'PL1', sourceUrl: 'incoming', title: 'Incoming', titleSource: 'youtube', tags: [],
      createdAt: 1, updatedAt: 800, metadataUpdatedAt: 100,
      videos: [{ videoId: 'v1', position: 1, watched: false, resumeSeconds: 0, progressUpdatedAt: 500, firstSeenAt: 1, lastSeenAt: 800, embedStatus: 'unknown' }],
    }],
  }

  const merged = mergeBackupData(local, incoming, () => 'unused')
  const video = merged.videos[0]
  assert.equal(video.position, 1)
  assert.equal(video.removedAt, undefined)
  assert.equal(video.watched, true)
  assert.equal(video.resumeSeconds, 33)
})
