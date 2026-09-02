"""Regression tests for the defects found in the September 2026 audit.

Each test names the audit finding it guards. They were written to fail against
the shipped v1 and must never be weakened to make a change pass.
"""
import pytest
from playwright.sync_api import expect

from .helpers import (add_course, add_rust_course, advance, play, player,
                      read_videos, seek, set_state, video_by_id)


def test_resume_position_advances_during_uninterrupted_playback(page, open_app):
    """Audit #2. The real IFrame API fires no events while a video plays, so the
    autosave must poll the player rather than replay a frozen snapshot."""
    open_app('#/add')
    add_rust_course(page)
    play(page, duration=600)
    for _ in range(12):
        page.wait_for_timeout(1000)
        advance(page, 30)
    page.wait_for_timeout(1200)

    lesson = video_by_id(page, 'rust-1')
    assert lesson['resumeSeconds'] > 200, (
        f"resume position stalled at {lesson['resumeSeconds']}s after ~360s of playback"
    )
    assert lesson['watched'] is False


def test_autocomplete_updates_the_screen(page, open_app):
    """Audit #4. Crossing 95% must be visible without a reload."""
    open_app('#/add')
    add_rust_course(page)
    expect(page.locator('.course-header .progress-caption')).to_contain_text('0 / 3')

    seek(page, 96)
    set_state(page, 'paused')

    expect(page.locator('.course-header .progress-caption')).to_contain_text('1 / 3')
    expect(page.locator('.lesson-row--active .lesson-row__state')).to_contain_text('✓')


def test_mark_watched_button_matches_its_action(page, open_app):
    """Audit #3. After auto-completion the button previously still read
    'Mark as watched' while its action un-marked the lesson."""
    open_app('#/add')
    add_rust_course(page)
    seek(page, 96)
    set_state(page, 'paused')

    expect(page.get_by_role('button', name='✓ Mark unwatched')).to_be_visible()
    assert video_by_id(page, 'rust-1')['watched'] is True

    page.get_by_role('button', name='✓ Mark unwatched').click()
    expect(page.get_by_role('button', name='✓ Mark as watched')).to_be_visible()
    assert video_by_id(page, 'rust-1')['watched'] is False


def test_manual_unwatch_is_not_undone_by_autocomplete(page, open_app):
    """Audit #7 side effect. Unwatching a lesson parked past 95% must stick even
    when playback runs out the remaining seconds."""
    open_app('#/add')
    add_rust_course(page)
    seek(page, 99)
    set_state(page, 'paused')
    page.get_by_role('button', name='✓ Mark unwatched').click()
    expect(page.get_by_role('button', name='✓ Mark as watched')).to_be_visible()

    set_state(page, 'playing')
    advance(page, 1)
    set_state(page, 'ended')
    page.wait_for_timeout(400)

    assert video_by_id(page, 'rust-1')['watched'] is False


def test_player_survives_marking_watched(page, open_app):
    """Audit #7. Toggling watched state must not tear down the running player."""
    open_app('#/add')
    add_rust_course(page)
    play(page, duration=600)
    advance(page, 120)
    before = player(page)['mountId']

    page.get_by_role('button', name='✓ Mark as watched').click()
    expect(page.get_by_role('button', name='✓ Mark unwatched')).to_be_visible()

    after = player(page)['mountId']
    assert after == before, 'player was destroyed and remounted by a UI-only update'


def test_player_survives_toggling_removed_lessons(page, open_app):
    """Audit #7. Same guarantee for the removed-lessons disclosure."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='↻ Refresh playlist').click()
    expect(page.locator('.refresh-summary')).to_contain_text('1 removed')
    before = player(page)['mountId']
    page.get_by_role('checkbox', name='Show removed lessons').check()
    expect(page.locator('.lesson-row--removed')).to_have_count(1)
    assert player(page)['mountId'] == before


def test_switching_lesson_reuses_the_same_player(page, open_app):
    """Audit #7. Lesson changes should call load() on the live player."""
    open_app('#/add')
    add_rust_course(page)
    before = player(page)['mountId']
    page.get_by_role('button', name='Next unwatched →').click()
    expect(page.locator('.lesson-row--active')).to_contain_text('Ownership and Borrowing')
    current = player(page)
    assert current['videoId'] == 'rust-2'
    assert current['mountId'] == before, 'lesson switch remounted the player'


def test_search_accepts_typed_input(page, open_app):
    """Audit #1. Typing must not destroy the input being typed into."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('link', name='Library', exact=True).click()
    search = page.get_by_role('searchbox', name='Search courses')
    search.click()
    search.press_sequentially('Rust', delay=60)

    expect(search).to_have_value('Rust')
    assert page.evaluate("document.activeElement?.getAttribute('aria-label')") == 'Search courses'


def test_tag_input_keeps_focus_while_metadata_loads(page, open_app):
    """Audit #18. Background enrichment must not steal the caret."""
    open_app('#/add')
    page.locator('textarea[aria-label="Playlist URLs"]').fill(
        'https://www.youtube.com/playlist?list=PL_RUST')
    page.get_by_role('button', name='Discover playlist(s) →').click()
    tags = page.locator('input[aria-label^="Tags for"]')
    tags.click()
    tags.press_sequentially('Rust, Beginner', delay=30)
    expect(tags).to_have_value('Rust, Beginner')


def test_refreshed_lesson_titles_appear_without_navigating(page, open_app):
    """Audit #8. Metadata fetched after a refresh must reach the screen."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='↻ Refresh playlist').click()
    expect(page.locator('.refresh-summary')).to_contain_text('1 added')
    expect(page.locator('.lesson-list')).to_contain_text('Traits and Generics')


@pytest.mark.parametrize('width', [320, 360, 375, 390, 393, 412, 414, 430, 480, 520])
def test_no_horizontal_overflow(page, open_app, width):
    """Audit #6. Every mainstream phone width must fit."""
    page.set_viewport_size({'width': width, 'height': 900})
    open_app('#/add')
    add_rust_course(page)
    for route in ['#/', '#/add', '#/settings']:
        page.goto(page.url.split('#')[0] + route)
        page.wait_for_timeout(250)
        overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        assert overflow <= 0, f'{route} overflows by {overflow}px at {width}px'


def test_course_can_be_deleted(page, open_app):
    """Audit #9. A local-first app must let users remove their own data."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='Edit course').click()
    page.get_by_role('button', name='Delete course').click()
    page.get_by_role('button', name='Delete permanently').click()
    expect(page.get_by_role('heading', name='Add your first YouTube course')).to_be_visible()
    assert read_videos(page) == []


def test_course_title_and_tags_can_be_edited(page, open_app):
    """Audit #9."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='Edit course').click()
    page.locator('input[aria-label="Course title"]').fill('Rust, revisited')
    page.locator('input[aria-label="Course tags"]').fill('Systems, Advanced')
    page.get_by_role('button', name='Save changes').click()
    expect(page.locator('.course-header h1')).to_have_text('Rust, revisited')
    page.get_by_role('link', name='Library', exact=True).click()
    expect(page.get_by_text('Systems').first).to_be_visible()


def test_removed_lessons_do_not_duplicate_numbering(page, open_app):
    """Audit #12."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='↻ Refresh playlist').click()
    expect(page.locator('.refresh-summary')).to_contain_text('1 removed')
    page.get_by_role('checkbox', name='Show removed lessons').check()
    numbers = page.locator('.lesson-row:not(.lesson-row--removed) .lesson-row__position')
    values = numbers.all_inner_texts()
    assert values == sorted(values, key=int)
    assert len(values) == len(set(values)), f'duplicate lesson numbers: {values}'


def test_mass_removal_is_confirmed_not_silent(page, open_app):
    """Audit #13. A truncated playlist must not silently retire lessons."""
    open_app('#/add')
    add_course(page, 'truncated', tags='Big')
    before = [v for v in read_videos(page) if not v['removed']]
    assert len(before) == 40

    page.get_by_role('button', name='↻ Refresh playlist').click()
    expect(page.get_by_role('heading', name='Confirm a large change')).to_be_visible()
    page.get_by_role('button', name='Keep my lessons').click()

    after = [v for v in read_videos(page) if not v['removed']]
    assert len(after) == 40, 'lessons were retired without confirmation'


def test_hostile_backup_values_are_rejected(page, open_app, tmp_path):
    """Audit #16 and #24."""
    import json
    bad = tmp_path / 'bad.json'
    bad.write_text(json.dumps({
        'schemaVersion': 1,
        'exportedAt': 'not-a-date',
        'courses': [],
    }))
    open_app('#/settings')
    page.locator('input[aria-label="Choose CourseTracker backup"]').set_input_files(str(bad))
    expect(page.locator('.inline-error')).to_contain_text('exportedAt')


def test_deleting_a_course_offers_a_working_undo(page, open_app):
    """Audit #9. Deletion is destructive, so the undo path must actually restore
    the course and its progress, not just show a button."""
    open_app('#/add')
    add_rust_course(page)
    page.get_by_role('button', name='✓ Mark as watched').click()
    expect(page.get_by_role('button', name='✓ Mark unwatched')).to_be_visible()

    page.get_by_role('button', name='Edit course').click()
    page.get_by_role('button', name='Delete course').click()
    page.get_by_role('button', name='Delete permanently').click()
    expect(page.get_by_role('heading', name='Add your first YouTube course')).to_be_visible()

    page.get_by_role('button', name='Undo').click()
    expect(page.locator('.course-header h1')).to_have_text('Rust Programming Full Course')
    restored = read_videos(page)
    assert len(restored) == 3
    assert [v for v in restored if v['videoId'] == 'rust-1'][0]['watched'] is True


def test_a_storage_failure_is_reported_not_swallowed(page, open_app):
    """Progress that silently stops saving is worse than a visible failure."""
    open_app('#/add')
    add_rust_course(page)
    page.evaluate("""async () => {
      const { CourseStore } = await import('./src/storage.js')
      CourseStore.prototype.updateProgress = () => Promise.reject(new Error('quota exceeded'))
    }""")
    page.evaluate("window.__COURSETRACKER_E2E__.seekTo(96)")
    page.evaluate("window.__COURSETRACKER_E2E__.setState('paused')")
    expect(page.locator('.toast--error')).to_contain_text('no longer save progress')
    expect(page.locator('.course-header h1')).to_be_visible()
