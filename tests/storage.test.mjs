import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { checkIndexedDb, CourseStore, DB_NAME, DB_VERSION, MIGRATIONS } from '../site/src/storage.js'

function freshStore() {
  return new CourseStore(`db-${Math.random().toString(36).slice(2)}`, new IDBFactory())
}

function course(overrides = {}) {
  return {
    id: 'course-1', playlistId: 'PL_A', sourceUrl: 'https://www.youtube.com/playlist?list=PL_A',
    title: 'Course A', titleSource: 'youtube', tags: ['Rust'],
    createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1, ...overrides,
  }
}

function video(overrides = {}) {
  return {
    courseId: 'course-1', videoId: 'v1', position: 0, watched: false, resumeSeconds: 0,
    progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown', ...overrides,
  }
}

test('storage reports unavailable when IndexedDB is not present', async () => {
  assert.equal(await checkIndexedDb(null), false)
  assert.equal(DB_NAME, 'course-tracker')
  assert.equal(DB_VERSION, 2)
})

test('a factory that refuses to open is reported as unavailable', async () => {
  const broken = {
    open() {
      const request = {}
      queueMicrotask(() => request.onerror?.())
      return request
    },
    deleteDatabase() { return {} },
  }
  assert.equal(await checkIndexedDb(broken), false)
})

test('checkIndexedDb succeeds against a working factory', async () => {
  assert.equal(await checkIndexedDb(new IDBFactory()), true)
})

test('a course round-trips with its lessons in position order', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'b', position: 1 }), video({ videoId: 'a', position: 0 })])
  const stored = await store.getCourse('course-1')
  assert.equal(stored.title, 'Course A')
  assert.deepEqual((await store.getCourseVideos('course-1')).map((v) => v.videoId), ['a', 'b'])
  assert.equal((await store.getCourseByPlaylistId('PL_A')).id, 'course-1')
})

test('the playlistId index rejects a duplicate course', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video()])
  await assert.rejects(
    store.createCourse(course({ id: 'course-2' }), [video({ courseId: 'course-2' })]),
    (error) => error.name === 'ConstraintError' || /constraint/i.test(error.message),
  )
  assert.equal((await store.listCourses()).length, 1)
})

test('updateProgress clamps a negative resume position', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video()])
  await store.updateProgress('course-1', 'v1', { watched: true, resumeSeconds: -50, progressUpdatedAt: 9 })
  const stored = await store.getCourseVideo('course-1', 'v1')
  assert.equal(stored.resumeSeconds, 0)
  assert.equal(stored.watched, true)
})

test('replaceCourseVideos removes every prior lesson for the course only', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'a' }), video({ videoId: 'b', position: 1 })])
  await store.createCourse(course({ id: 'course-2', playlistId: 'PL_B' }), [video({ courseId: 'course-2', videoId: 'z' })])
  await store.replaceCourseVideos('course-1', [video({ videoId: 'c' })])
  assert.deepEqual((await store.getCourseVideos('course-1')).map((v) => v.videoId), ['c'])
  assert.deepEqual((await store.getCourseVideos('course-2')).map((v) => v.videoId), ['z'])
})

test('applyRefresh commits lessons and the course patch together', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'a' })])
  await store.applyRefresh('course-1', [video({ videoId: 'b' })], { lastRefreshedAt: 77, updatedAt: 77 })
  assert.equal((await store.getCourse('course-1')).lastRefreshedAt, 77)
  assert.deepEqual((await store.getCourseVideos('course-1')).map((v) => v.videoId), ['b'])
})

test('applyRefresh leaves everything untouched when the course is missing', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'a' })])
  await assert.rejects(store.applyRefresh('nope', [video({ videoId: 'b' })], { updatedAt: 5 }))
  assert.deepEqual((await store.getCourseVideos('course-1')).map((v) => v.videoId), ['a'])
})

test('deleteCourse removes the course and its lessons but spares others', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'a' }), video({ videoId: 'b', position: 1 })])
  await store.createCourse(course({ id: 'course-2', playlistId: 'PL_B' }), [video({ courseId: 'course-2', videoId: 'z' })])
  await store.deleteCourse('course-1')
  assert.equal(await store.getCourse('course-1'), undefined)
  assert.deepEqual(await store.getCourseVideos('course-1'), [])
  assert.deepEqual((await store.getCourseVideos('course-2')).map((v) => v.videoId), ['z'])
})

test('a deleted course can be restored exactly', async () => {
  const store = freshStore()
  const videos = [video({ videoId: 'a', watched: true, resumeSeconds: 42 })]
  await store.createCourse(course(), videos)
  const saved = await store.getCourseVideos('course-1')
  await store.deleteCourse('course-1')
  await store.restoreCourse(course(), saved)
  const restored = await store.getCourseVideos('course-1')
  assert.equal(restored[0].resumeSeconds, 42)
  assert.equal(restored[0].watched, true)
})

test('a failed replaceSnapshot rolls back and keeps the existing library', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video()])
  // Two courses sharing a playlistId violate the unique index mid-transaction.
  await assert.rejects(store.replaceSnapshot({
    courses: [course({ id: 'x', playlistId: 'PL_DUP' }), course({ id: 'y', playlistId: 'PL_DUP' })],
    videos: [],
  }))
  const survivors = await store.listCourses()
  assert.equal(survivors.length, 1)
  assert.equal(survivors[0].id, 'course-1')
})

test('listCoursesWithVideos groups lessons per course in one read', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video({ videoId: 'b', position: 1 }), video({ videoId: 'a', position: 0 })])
  await store.createCourse(course({ id: 'course-2', playlistId: 'PL_B' }), [video({ courseId: 'course-2', videoId: 'z' })])
  const { courses, videosByCourseId } = await store.listCoursesWithVideos()
  assert.equal(courses.length, 2)
  assert.deepEqual(videosByCourseId.get('course-1').map((v) => v.videoId), ['a', 'b'])
  assert.deepEqual(videosByCourseId.get('course-2').map((v) => v.videoId), ['z'])
})

test('clearData empties both stores', async () => {
  const store = freshStore()
  await store.createCourse(course(), [video()])
  await store.clearData()
  assert.deepEqual(await store.listCourses(), [])
  assert.deepEqual((await store.snapshot()).videos, [])
})

test('the v2 migration drops the unused settings store', async () => {
  const factory = new IDBFactory()
  const name = 'legacy-db'
  // Build a v1-shaped database, settings store and all.
  await new Promise((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const courses = db.createObjectStore('courses', { keyPath: 'id' })
      courses.createIndex('playlistId', 'playlistId', { unique: true })
      courses.createIndex('lastOpenedAt', 'lastOpenedAt')
      courses.createIndex('updatedAt', 'updatedAt')
      const videos = db.createObjectStore('videos', { keyPath: ['courseId', 'videoId'] })
      videos.createIndex('courseId', 'courseId')
      videos.createIndex('videoId', 'videoId')
      videos.createIndex('progressUpdatedAt', 'progressUpdatedAt')
      db.createObjectStore('settings', { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['courses', 'videos'], 'readwrite')
      tx.objectStore('courses').add(course())
      tx.objectStore('videos').add(video({ watched: true, resumeSeconds: 12 }))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })

  const store = new CourseStore(name, factory)
  const db = await store.db()
  assert.equal(db.version, 2)
  assert.equal(db.objectStoreNames.contains('settings'), false)
  // Existing progress survives the upgrade.
  const stored = await store.getCourseVideo('course-1', 'v1')
  assert.equal(stored.resumeSeconds, 12)
  assert.equal(stored.watched, true)
})

test('every migration key is a version at or below DB_VERSION', () => {
  for (const version of Object.keys(MIGRATIONS).map(Number)) {
    assert.ok(Number.isInteger(version) && version > 1 && version <= DB_VERSION,
      `migration ${version} is not reachable from DB_VERSION ${DB_VERSION}`)
  }
})
