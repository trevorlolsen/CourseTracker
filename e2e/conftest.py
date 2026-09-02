import contextlib
import socket
import subprocess
import time
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

expect.set_options(timeout=4000)

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def free_port():
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def base_url():
    port = free_port()
    process = subprocess.Popen(
        ["python", "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(SITE)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    else:
        process.terminate()
        raise RuntimeError("Static test server did not start")
    yield url
    process.terminate()
    process.wait(timeout=5)


@pytest.fixture()
def page():
    with sync_playwright() as p:
        launch_options = {"headless": True}
        system_chromium = Path("/usr/bin/chromium")
        if system_chromium.exists():
            launch_options["executable_path"] = str(system_chromium)
        browser = p.chromium.launch(**launch_options)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.set_default_timeout(6000)
        yield page
        context.close()
        browser.close()


@pytest.fixture()
def open_app(page, base_url):
    def _open(hash_path="#/", e2e=True):
        query = "?e2e=1" if e2e else ""
        try:
            page.goto(f"{base_url}/{query}{hash_path}")
        except PlaywrightError as error:
            if "ERR_BLOCKED_BY_ADMINISTRATOR" in str(error):
                raise RuntimeError(
                    "Browser tests require Chromium network access, but navigation was "
                    "blocked by environment policy. Run `python -m playwright install "
                    "chromium`. Refusing to skip: silently skipping this suite previously "
                    "let a failing test run report success."
                ) from error
            raise
        return page
    return _open
