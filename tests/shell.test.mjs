import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function text(path) { return readFile(new URL(path, import.meta.url), 'utf8') }

// These assert on the shipped static contract only (things a browser test
// cannot see, like deploy-path assumptions). Behaviour belongs in e2e/.

test('the entry point is a relative, build-free ES module suitable for a Pages subpath', async () => {
  const html = await text('../site/index.html')
  assert.match(html, /name="viewport"/)
  assert.match(html, /type="module" src="\.\/src\/app\.js"/)
  assert.match(html, /href="\.\/styles\.css"/)
  assert.doesNotMatch(html, /src="\//, 'absolute asset paths break a repository subpath')
  // The manifest and apple-touch-icon links are subject to the same rule; an
  // absolute href would point at the account root, not this project.
  assert.doesNotMatch(html, /href="\/[^/]/, 'absolute link paths break a repository subpath')
})

test('the app container is not itself a live region', async () => {
  const html = await text('../site/index.html')
  const appTag = html.match(/<div id="app"[^>]*>/)[0]
  assert.doesNotMatch(appTag, /aria-live/,
    'making the whole app a live region announces every route change in full')
})

test('no module imports a bare package specifier', async () => {
  const files = ['app.js', 'dom.js', 'domain.js', 'storage.js', 'backup.js', 'youtube.js', 'view-models.js', 'install.js']
  for (const file of files) {
    const source = await text(`../site/src/${file}`)
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.match(match[1], /^\.{1,2}\//, `${file} imports ${match[1]}, which needs a bundler`)
    }
  }
})

test('the entry point ships a Content Security Policy without unsafe sources', async () => {
  const html = await text('../site/index.html')
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
  assert.ok(csp, 'CSP meta tag missing from index.html')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /base-uri 'none'/)
  assert.doesNotMatch(csp, /unsafe-eval/)
  // YouTube's widget script sets a style attribute on the iframe it creates.
  // That single allowance must stay scoped to attributes, never to elements.
  assert.match(csp, /style-src-attr 'unsafe-inline'/)
  assert.doesNotMatch(csp.replace(/style-src-attr 'unsafe-inline'/, ''), /unsafe-inline/,
    "'unsafe-inline' is only acceptable on style-src-attr")
  assert.doesNotMatch(csp, /\s\*[\s;]|https?:\/\/\*[\s;]/, 'a bare wildcard source defeats the policy')
})

test('the E2E adapter is only honoured on local hosts', async () => {
  const app = await text('../site/src/app.js')
  assert.match(app, /LOCAL_HOSTS\.has\(location\.hostname\)/)
})

test('deploy workflow pins every action to a commit SHA', async () => {
  const workflow = await text('../.github/workflows/deploy-pages.yml')
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  assert.ok(uses.length >= 6, 'expected the deploy workflow to use several actions')
  for (const ref of uses) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is pinned to a mutable tag, not a commit SHA`)
  }
})

test('player iframes use the no-cookie host but the API script comes from www.youtube.com', async () => {
  const youtube = await text('../site/src/youtube.js')
  assert.match(youtube, /const EMBED_ORIGIN = 'https:\/\/www\.youtube-nocookie\.com'/)
  // youtube-nocookie.com returns 404 for /iframe_api; only www.youtube.com serves it.
  assert.match(youtube, /const IFRAME_API_URL = 'https:\/\/www\.youtube\.com\/iframe_api'/)
  assert.doesNotMatch(youtube, /youtube-nocookie\.com\/iframe_api|\$\{EMBED_ORIGIN\}\/iframe_api/,
    'the IFrame API bootstrap is not served from the no-cookie host')
  const csp = (await text('../site/index.html')).match(/Content-Security-Policy" content="([^"]+)"/)[1]
  assert.match(csp, /script-src[^;]*https:\/\/www\.youtube\.com/, 'CSP must allow the API script host')
})
