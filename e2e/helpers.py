from playwright.sync_api import expect

PLAYLIST_URLS = {
    'rust': 'https://www.youtube.com/playlist?list=PL_RUST',
    'large': 'https://www.youtube.com/playlist?list=PL_LARGE',
    'truncated': 'https://www.youtube.com/playlist?list=PL_TRUNCATED',
}


def add_course(page, key='rust', tags='Rust, Beginner', open_course=True):
    """Import a playlist through the Add screen and optionally open it."""
    page.locator('textarea[aria-label="Playlist URLs"]').fill(PLAYLIST_URLS[key])
    page.get_by_role('button', name='Discover playlist(s) →').click()
    expect(page.locator('.import-item .inline-note')).to_contain_text('lessons discovered')
    if tags is not None:
        page.locator('input[aria-label^="Tags for"]').fill(tags)
    page.get_by_role('button', name='Add Course').click()
    expect(page.get_by_text('This course is now in your local library.')).to_be_visible()
    if open_course:
        page.get_by_role('link', name='Open existing course').click()
        expect(page.locator('.course-header h1')).not_to_be_empty()


def add_rust_course(page):
    add_course(page, 'rust')


def read_videos(page):
    """Return stored lesson rows straight from IndexedDB."""
    return page.evaluate("""async () => {
      const { CourseStore } = await import('./src/storage.js')
      const snapshot = await new CourseStore().snapshot()
      return snapshot.videos
        .slice()
        .sort((a, b) => a.position - b.position)
        .map(v => ({
          videoId: v.videoId,
          watched: v.watched,
          resumeSeconds: Math.round(v.resumeSeconds),
          removed: v.removedAt !== undefined,
          title: v.title ?? null,
        }))
    }""")


def video_by_id(page, video_id):
    return next(v for v in read_videos(page) if v['videoId'] == video_id)


def player(page):
    return page.evaluate("window.__COURSETRACKER_E2E__.currentPlayer()")


def play(page, duration=None):
    if duration is not None:
        page.evaluate(f"window.__COURSETRACKER_E2E__.setDuration({duration})")
    page.evaluate("window.__COURSETRACKER_E2E__.setState('playing')")


def advance(page, seconds):
    """Advance the virtual playhead WITHOUT emitting an event (real API behaviour)."""
    page.evaluate(f"window.__COURSETRACKER_E2E__.advanceTime({seconds})")


def set_state(page, state):
    page.evaluate(f"window.__COURSETRACKER_E2E__.setState('{state}')")


def seek(page, seconds):
    page.evaluate(f"window.__COURSETRACKER_E2E__.seekTo({seconds})")
