def test_indexeddb_store_crud_and_progress(page, open_app):
    open_app('#/', e2e=False)
    result = page.evaluate("""async () => {
      const { CourseStore } = await import('./src/storage.js')
      const name = `test-${crypto.randomUUID()}`
      const store = new CourseStore(name)
      const now = 100
      const course = { id: 'c1', playlistId: 'PL1', sourceUrl: '', title: 'Course', titleSource: 'user', tags: ['Rust'], createdAt: now, updatedAt: now, metadataUpdatedAt: now }
      const videos = [{ courseId: 'c1', videoId: 'v1', position: 0, title: 'Lesson', watched: false, resumeSeconds: 0, progressUpdatedAt: now, firstSeenAt: now, lastSeenAt: now, embedStatus: 'unknown' }]
      await store.createCourse(course, videos)
      await store.updateProgress('c1', 'v1', { watched: true, resumeSeconds: 42, progressUpdatedAt: 200 })
      const byPlaylist = await store.getCourseByPlaylistId('PL1')
      const video = await store.getCourseVideo('c1', 'v1')
      const snapshot = await store.snapshot()
      await store.destroyDatabase()
      return { byPlaylist, video, snapshot }
    }""")
    assert result["byPlaylist"]["id"] == "c1"
    assert result["video"]["title"] == "Lesson"
    assert result["video"]["watched"] is True
    assert result["video"]["resumeSeconds"] == 42
    assert len(result["snapshot"]["courses"]) == 1
    assert len(result["snapshot"]["videos"]) == 1


def test_course_creation_is_atomic(page, open_app):
    open_app('#/', e2e=False)
    result = page.evaluate("""async () => {
      const { CourseStore } = await import('./src/storage.js')
      const name = `test-${crypto.randomUUID()}`
      const store = new CourseStore(name)
      const course = { id: 'c1', playlistId: 'PL1', sourceUrl: '', title: 'Course', titleSource: 'user', tags: [], createdAt: 1, updatedAt: 1, metadataUpdatedAt: 1 }
      const video = { courseId: 'c1', videoId: 'v1', position: 0, watched: false, resumeSeconds: 0, progressUpdatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, embedStatus: 'unknown' }
      await store.createCourse(course, [video])
      let failed = false
      try {
        await store.createCourse({ ...course, id: 'c2' }, [{ ...video, courseId: 'c2', videoId: 'v2' }])
      } catch { failed = true }
      const courses = await store.listCourses()
      const videos = await store.getCourseVideos('c2')
      await store.destroyDatabase()
      return { failed, courseCount: courses.length, partialVideos: videos.length }
    }""")
    assert result == {"failed": True, "courseCount": 1, "partialVideos": 0}
