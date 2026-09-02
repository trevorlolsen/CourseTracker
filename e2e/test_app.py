import json
import re

from playwright.sync_api import expect

from .helpers import add_course, add_rust_course, player, read_videos, video_by_id


def test_add_course_and_library_progress(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('Rust Programming Full Course').first).to_be_visible()
    expect(page.get_by_text('0 / 3 watched')).to_be_visible()
    expect(page.get_by_text('Rust').first).to_be_visible()
    expect(page.get_by_text('Beginner').first).to_be_visible()


def test_progress_resume_and_continue(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    page.evaluate("window.__COURSETRACKER_E2E__.seekTo(95)")
    page.evaluate("window.__COURSETRACKER_E2E__.setState('paused')")
    expect(page.get_by_role('button', name='✓ Mark unwatched')).to_be_visible()

    page.get_by_role('button', name='Next unwatched →').click()
    expect(page.locator('.lesson-row--active')).to_contain_text('Ownership and Borrowing')

    page.evaluate("window.__COURSETRACKER_E2E__.seekTo(42)")
    page.evaluate("window.__COURSETRACKER_E2E__.setState('paused')")
    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('1 / 3 watched')).to_be_visible()

    page.get_by_role('link', name='▶ Continue').click()
    expect(page.locator('.lesson-row--active')).to_contain_text('Ownership and Borrowing')
    current = player(page)
    assert current['videoId'] == 'rust-2'
    assert round(current['startSeconds']) == 42


def test_manual_refresh_preserves_progress_and_shows_removed(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='✓ Mark as watched').click()
    page.get_by_role('button', name='↻ Refresh playlist').click()
    expect(page.locator('.refresh-summary')).to_contain_text('1 added · 1 removed · 2 unchanged')

    page.get_by_role('checkbox', name='Show removed lessons').check()
    expect(page.locator('.lesson-row--removed')).to_have_count(1)
    expect(page.locator('.lesson-row--removed')).to_contain_text('Enums and Pattern Matching')

    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('1 / 3 watched')).to_be_visible()


def test_backup_download_preview_merge_and_restore(page, open_app, tmp_path):
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='✓ Mark as watched').click()
    page.get_by_role('link', name='Settings', exact=True).click()
    with page.expect_download() as download_info:
        page.get_by_role('button', name='Download backup').click()
    download = download_info.value
    backup_path = tmp_path / 'backup.json'
    download.save_as(str(backup_path))
    parsed = json.loads(backup_path.read_text())
    assert parsed['schemaVersion'] == 1
    assert parsed['courses'][0]['playlistId'] == 'PL_RUST'

    page.evaluate("""async () => {
      const { CourseStore } = await import('./src/storage.js')
      await new CourseStore().clearData()
    }""")
    page.reload()
    page.get_by_role('link', name='Settings', exact=True).click()
    page.locator('input[aria-label="Choose CourseTracker backup"]').set_input_files(str(backup_path))
    expect(page.get_by_text('1 courses · 3 lessons')).to_be_visible()
    page.get_by_role('button', name='Merge').click()
    page.get_by_role('button', name='Merge backup').click()
    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('Rust Programming Full Course').first).to_be_visible()
    expect(page.get_by_text('1 / 3 watched')).to_be_visible()


def test_mobile_player_first_and_no_horizontal_scroll(page, open_app):
    page.set_viewport_size({"width": 412, "height": 915})
    open_app('#/add')
    add_rust_course(page)
    player_box = page.locator('.player-frame').bounding_box()
    disclosure_box = page.get_by_role('button', name='Course Content').bounding_box()
    assert player_box['y'] < disclosure_box['y']
    page.get_by_role('button', name='Course Content').click()
    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')


def test_manual_watched_state_can_be_corrected(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='✓ Mark as watched').click()
    expect(page.get_by_role('button', name='✓ Mark unwatched')).to_be_visible()
    page.get_by_role('button', name='✓ Mark unwatched').click()
    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('0 / 3 watched')).to_be_visible()


def test_completed_lessons_are_hidden_by_default(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    lessons = page.locator('.lesson-list')
    expect(lessons).to_contain_text('Introduction to Rust')

    # The lesson on screen stays listed even once complete, so the viewer does
    # not lose their place the moment they mark it watched.
    page.get_by_role('button', name='✓ Mark as watched').click()
    expect(lessons).to_contain_text('Introduction to Rust')

    # Moving on is what actually retires it from the list.
    page.get_by_role('button', name='Next unwatched →').click()
    expect(lessons).not_to_contain_text('Introduction to Rust')
    expect(page.locator('.lesson-panel__header')).to_contain_text('1 / 3 completed · 1 hidden')

    page.locator('input[aria-label="Hide completed lessons"]').uncheck()
    expect(lessons).to_contain_text('Introduction to Rust')
    expect(page.locator('.lesson-panel__header')).not_to_contain_text('hidden')


def test_library_search_and_combined_tag_filters(page, open_app):
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('link', name='Library', exact=True).click()

    search = page.get_by_role('searchbox', name='Search courses')
    search.fill('CourseTracker Test Channel')
    expect(page.get_by_text('Rust Programming Full Course').first).to_be_visible()
    search.fill('Python')
    expect(page.get_by_role('heading', name='No courses match')).to_be_visible()
    search.fill('')

    page.get_by_role('button', name='Rust', exact=True).click()
    page.get_by_role('button', name='Beginner', exact=True).click()
    expect(page.get_by_text('Rust Programming Full Course').first).to_be_visible()
    assert page.get_by_role('button', name='Rust', exact=True).get_attribute('aria-pressed') == 'true'
    assert page.get_by_role('button', name='Beginner', exact=True).get_attribute('aria-pressed') == 'true'


def test_backup_file_selected_from_add_screen_opens_settings_preview(page, open_app, tmp_path):
    backup_path = tmp_path / 'empty-backup.json'
    backup_path.write_text(json.dumps({
        'schemaVersion': 1,
        'exportedAt': '2026-09-02T12:00:00.000Z',
        'courses': [],
    }))
    open_app('#/add')
    page.locator('input[aria-label="Import playlist list or backup file"]').set_input_files(str(backup_path))
    expect(page.get_by_role('heading', name='Settings & Transfer')).to_be_visible()
    expect(page.get_by_text('0 courses · 0 lessons')).to_be_visible()
