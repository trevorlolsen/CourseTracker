export const DB_NAME = 'course-tracker'
export const DB_VERSION = 2

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * Resolves when the transaction commits. A failing request inside the
 * transaction is captured first, so callers see the real DOMException
 * (ConstraintError and friends) rather than a generic wrapper.
 */
function transactionDone(transaction) {
  let firstError
  const capture = (event) => {
    firstError = firstError ?? event?.target?.error ?? transaction.error
  }
  transaction.addEventListener('error', capture, true)
  return new Promise((resolve, reject) => {
    const fail = (fallback) => reject(firstError ?? transaction.error ?? new Error(fallback))
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => fail('IndexedDB transaction aborted')
    transaction.onerror = () => fail('IndexedDB transaction failed')
  })
}

function createInitialStores(db) {
  if (!db.objectStoreNames.contains('courses')) {
    const courses = db.createObjectStore('courses', { keyPath: 'id' })
    courses.createIndex('playlistId', 'playlistId', { unique: true })
    courses.createIndex('lastOpenedAt', 'lastOpenedAt')
    courses.createIndex('updatedAt', 'updatedAt')
  }
  if (!db.objectStoreNames.contains('videos')) {
    const videos = db.createObjectStore('videos', { keyPath: ['courseId', 'videoId'] })
    videos.createIndex('courseId', 'courseId')
    videos.createIndex('videoId', 'videoId')
    videos.createIndex('progressUpdatedAt', 'progressUpdatedAt')
  }
}

/**
 * Ordered schema migrations. Each key is the version it upgrades *to* and runs
 * when the existing database is older than that. Add new versions here and
 * bump DB_VERSION; never edit a migration that has shipped.
 */
export const MIGRATIONS = {
  2: (db) => {
    // v1 created a `settings` store and wrote a completionThreshold that
    // nothing ever read. Removing it keeps the schema honest.
    if (db.objectStoreNames.contains('settings')) db.deleteObjectStore('settings')
  },
}

async function openDatabase(name, factory) {
  if (!factory) throw new Error('IndexedDB is unavailable')
  const request = factory.open(name, DB_VERSION)
  request.onupgradeneeded = (event) => {
    const db = request.result
    if (event.oldVersion < 1) createInitialStores(db)
    else createInitialStores(db)
    for (const version of Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b)) {
      if (event.oldVersion < version) MIGRATIONS[version](db, request.transaction)
    }
  }
  return await requestToPromise(request)
}

async function deleteByIndex(store, indexName, key) {
  const index = store.index(indexName)
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(key))
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve()
      cursor.delete()
      cursor.continue()
    }
  })
}

export async function checkIndexedDb(factory = globalThis.indexedDB) {
  // Note: passing `undefined` falls back to the global factory. Pass `null` to
  // assert the "no IndexedDB at all" path.
  if (!factory) return false
  const name = `course-tracker-probe-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
  try {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('probe')
    const db = await requestToPromise(request)
    const tx = db.transaction(['probe'], 'readwrite')
    tx.objectStore('probe').put('ok', 'key')
    await transactionDone(tx)
    db.close()
    factory.deleteDatabase(name)
    return true
  } catch {
    try { factory.deleteDatabase(name) } catch { /* ignore */ }
    return false
  }
}

export class CourseStore {
  constructor(name = DB_NAME, factory = globalThis.indexedDB) {
    this.name = name
    this.factory = factory
    this.dbPromise = null
  }

  async db() {
    if (!this.dbPromise) this.dbPromise = openDatabase(this.name, this.factory)
    return this.dbPromise
  }

  async createCourse(course, videos) {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readwrite')
    tx.objectStore('courses').add(course)
    for (const video of videos) tx.objectStore('videos').add(video)
    await transactionDone(tx)
  }

  async getCourse(id) {
    const db = await this.db()
    const tx = db.transaction(['courses'], 'readonly')
    const result = await requestToPromise(tx.objectStore('courses').get(id))
    await transactionDone(tx)
    return result
  }

  async getCourseByPlaylistId(playlistId) {
    const db = await this.db()
    const tx = db.transaction(['courses'], 'readonly')
    const result = await requestToPromise(tx.objectStore('courses').index('playlistId').get(playlistId))
    await transactionDone(tx)
    return result
  }

  async listCourses() {
    const db = await this.db()
    const tx = db.transaction(['courses'], 'readonly')
    const rows = await requestToPromise(tx.objectStore('courses').getAll())
    await transactionDone(tx)
    return rows
  }

  /** Courses plus their lessons in a single transaction (avoids an N+1 read). */
  async listCoursesWithVideos() {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readonly')
    const courses = await requestToPromise(tx.objectStore('courses').getAll())
    const videos = await requestToPromise(tx.objectStore('videos').getAll())
    await transactionDone(tx)
    const videosByCourseId = new Map(courses.map((course) => [course.id, []]))
    for (const video of videos) {
      const bucket = videosByCourseId.get(video.courseId)
      if (bucket) bucket.push(video)
    }
    for (const bucket of videosByCourseId.values()) bucket.sort((a, b) => a.position - b.position)
    return { courses, videosByCourseId }
  }

  async getCourseVideo(courseId, videoId) {
    const db = await this.db()
    const tx = db.transaction(['videos'], 'readonly')
    const result = await requestToPromise(tx.objectStore('videos').get([courseId, videoId]))
    await transactionDone(tx)
    return result
  }

  async getCourseVideos(courseId) {
    const db = await this.db()
    const tx = db.transaction(['videos'], 'readonly')
    const rows = await requestToPromise(tx.objectStore('videos').index('courseId').getAll(courseId))
    await transactionDone(tx)
    return rows.sort((a, b) => a.position - b.position)
  }

  async updateCourse(id, patch) {
    const db = await this.db()
    const tx = db.transaction(['courses'], 'readwrite')
    const store = tx.objectStore('courses')
    const current = await requestToPromise(store.get(id))
    if (!current) throw new Error('Course not found')
    store.put({ ...current, ...patch, id: current.id })
    await transactionDone(tx)
  }

  async updateVideo(courseId, videoId, patch) {
    const db = await this.db()
    const tx = db.transaction(['videos'], 'readwrite')
    const store = tx.objectStore('videos')
    const current = await requestToPromise(store.get([courseId, videoId]))
    if (!current) throw new Error('Lesson not found')
    store.put({ ...current, ...patch, courseId: current.courseId, videoId: current.videoId })
    await transactionDone(tx)
  }

  async updateProgress(courseId, videoId, patch) {
    await this.updateVideo(courseId, videoId, {
      watched: Boolean(patch.watched),
      resumeSeconds: Math.max(0, Number(patch.resumeSeconds) || 0),
      progressUpdatedAt: Number(patch.progressUpdatedAt) || Date.now(),
    })
  }

  async replaceCourseVideos(courseId, videos) {
    const db = await this.db()
    const tx = db.transaction(['videos'], 'readwrite')
    const store = tx.objectStore('videos')
    await deleteByIndex(store, 'courseId', courseId)
    for (const video of videos) store.add({ ...video, courseId })
    await transactionDone(tx)
  }

  /** Atomic refresh: lesson replacement and the course patch commit together. */
  async applyRefresh(courseId, videos, coursePatch) {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readwrite')
    const courses = tx.objectStore('courses')
    const videoStore = tx.objectStore('videos')
    const current = await requestToPromise(courses.get(courseId))
    if (!current) throw new Error('Course not found')
    courses.put({ ...current, ...coursePatch, id: current.id })
    await deleteByIndex(videoStore, 'courseId', courseId)
    for (const video of videos) videoStore.add({ ...video, courseId })
    await transactionDone(tx)
  }

  async deleteCourse(courseId) {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readwrite')
    tx.objectStore('courses').delete(courseId)
    await deleteByIndex(tx.objectStore('videos'), 'courseId', courseId)
    await transactionDone(tx)
  }

  /** Re-insert a deleted course and its lessons, for undo. */
  async restoreCourse(course, videos) {
    await this.createCourse(course, videos)
  }

  async snapshot() {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readonly')
    const courses = await requestToPromise(tx.objectStore('courses').getAll())
    const videos = await requestToPromise(tx.objectStore('videos').getAll())
    await transactionDone(tx)
    return { courses, videos }
  }

  async replaceSnapshot(snapshot) {
    const db = await this.db()
    const tx = db.transaction(['courses', 'videos'], 'readwrite')
    const courses = tx.objectStore('courses')
    const videos = tx.objectStore('videos')
    courses.clear()
    videos.clear()
    for (const course of snapshot.courses) courses.add(course)
    for (const video of snapshot.videos) videos.add(video)
    await transactionDone(tx)
  }

  async clearData() {
    await this.replaceSnapshot({ courses: [], videos: [] })
  }

  async destroyDatabase() {
    if (this.dbPromise) {
      try { (await this.dbPromise).close() } catch { /* ignore */ }
      this.dbPromise = null
    }
    await new Promise((resolve, reject) => {
      const request = this.factory.deleteDatabase(this.name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Unable to delete IndexedDB database'))
      request.onblocked = () => reject(new Error('IndexedDB database deletion was blocked'))
    })
  }
}
