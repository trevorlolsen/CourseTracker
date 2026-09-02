"""Installability and offline behaviour of the app shell.

These use the `pwa_page` fixture, which permits service workers; every other
suite runs with them blocked so it tests the files on disk rather than a cache.
"""

from playwright.sync_api import expect


def _install_worker(page, base_url):
    """Load the app, wait for the worker, then reload so the page is controlled.

    The very first navigation is never controlled by a worker it registered
    itself, so anything worker-mediated has to be asserted after a reload.
    """
    page.goto(f"{base_url}/#/")
    expect(page.locator(".topbar")).to_be_visible()
    page.evaluate("navigator.serviceWorker.ready")
    page.reload()
    expect(page.locator(".topbar")).to_be_visible()
    return page


def test_service_worker_takes_control_and_precaches_the_shell(pwa_page, base_url):
    page = _install_worker(pwa_page, base_url)

    assert page.evaluate("Boolean(navigator.serviceWorker.controller)")

    cached = page.evaluate("""async () => {
      const names = await caches.keys()
      const shellName = names.find(n => n.startsWith('course-tracker-'))
      if (!shellName) return null
      const cache = await caches.open(shellName)
      const keys = await cache.keys()
      return { name: shellName, paths: keys.map(r => new URL(r.url).pathname) }
    }""")

    assert cached is not None, "no course-tracker cache was created"
    # The cache name carries the shell revision, which is what forces installed
    # users onto new code when any shell file changes.
    assert cached["name"] != "course-tracker-", "cache name is missing its revision"
    for expected in ("/index.html", "/styles.css", "/src/app.js", "/manifest.webmanifest"):
        assert any(p.endswith(expected) for p in cached["paths"]), f"{expected} was not precached"

    # The test double is deliberately excluded; caching it would ship test code.
    assert not any(p.endswith("e2e-adapter.js") for p in cached["paths"])


def test_app_shell_loads_and_renders_with_no_network(pwa_page, base_url):
    page = _install_worker(pwa_page, base_url)

    page.context.set_offline(True)
    try:
        page.reload()
        # The library renders from IndexedDB and the precached shell alone.
        expect(page.locator(".topbar")).to_be_visible()
        expect(page.locator("#route-view")).not_to_be_empty()
        # The advisory strip tells the user what still works and what does not.
        expect(page.locator(".offline-strip")).to_be_visible()
        expect(page.locator(".offline-strip")).to_contain_text("need YouTube")
    finally:
        page.context.set_offline(False)


def test_offline_strip_is_hidden_while_online(pwa_page, base_url):
    page = _install_worker(pwa_page, base_url)
    expect(page.locator(".offline-strip")).to_be_hidden()


def test_settings_offers_an_install_path_and_states_the_limits(pwa_page, base_url):
    page = _install_worker(pwa_page, base_url)
    page.goto(f"{base_url}/#/settings")

    section = page.locator(".settings-section", has=page.get_by_role("heading", name="Install on this device"))
    expect(section).to_be_visible()

    # Chromium headless fires no beforeinstallprompt, so the manual steps must
    # carry the whole path on their own -- which is also the iOS case.
    expect(section.locator(".install-steps li")).to_have_count(3)
    expect(section).to_contain_text("Add to Home Screen")
    # The promise made here has to match what the app can actually do.
    expect(section).to_contain_text("does not give you offline video")
    expect(section).to_contain_text("does not move your library")


def test_reloading_from_the_server_removes_the_worker_and_keeps_it_off(pwa_page, base_url):
    page = _install_worker(pwa_page, base_url)
    assert page.evaluate("Boolean(navigator.serviceWorker.controller)")

    page.goto(f"{base_url}/#/settings")
    # The button reloads once the worker is gone, so wait that out before
    # asking the new document what survived.
    with page.expect_navigation():
        page.get_by_role("button", name="Reload from the server").click()

    expect(page.locator(".topbar")).to_be_visible()
    remaining = page.evaluate("""async () => {
      const registrations = await navigator.serviceWorker.getRegistrations()
      const names = await caches.keys()
      return {
        registrations: registrations.length,
        caches: names.filter(n => n.startsWith('course-tracker-')).length,
      }
    }""")
    # Nothing came back. The reload must not re-register the worker it just
    # removed, or the escape hatch would be useless against a bad worker.
    assert remaining == {"registrations": 0, "caches": 0}

    # Still off after navigating around within the same session.
    page.goto(f"{base_url}/#/")
    expect(page.locator(".topbar")).to_be_visible()
    assert page.evaluate("navigator.serviceWorker.getRegistrations().then(r => r.length)") == 0
