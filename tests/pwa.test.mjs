import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { computeRevision, readDeclaredRevision, readShellList, SITE, SW_PATH } from '../scripts/shell-revision.mjs'
import { encodePng, ICONS, renderMark, RGB, RGBA } from '../scripts/generate-icons.mjs'

async function text(path) { return readFile(join(SITE, path), 'utf8') }

/**
 * Assertions below describe what the worker *does*, so they run against code
 * with the comments removed — otherwise a comment explaining why a pattern is
 * wrong reads as the pattern itself. Naive, but sw.js has no `//` inside any
 * string literal, which is the only case that would misfire.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/**
 * Files under site/ that are shipped but deliberately not precached. Listing
 * them here makes each exclusion a decision rather than an oversight — the
 * set-equality test below fails on anything not named in one list or the other.
 */
const SHELL_EXCLUDED = [
  // Test-only, and app.js imports it dynamically on local hosts alone. Caching
  // it would ship the test double to every installed user.
  './src/e2e-adapter.js',
  // The worker cannot meaningfully precache itself.
  './sw.js',
]

async function walkSite(dir = SITE) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkSite(full))
    else files.push(`./${relative(SITE, full).split('\\').join('/')}`)
  }
  return files
}

test('SHELL_REVISION matches the bytes it claims to describe', async () => {
  const source = await readFile(SW_PATH, 'utf8')
  const expected = await computeRevision(await readShellList(source))
  assert.equal(readDeclaredRevision(source), expected,
    'A shell file changed without bumping the revision. Installed users would '
    + 'keep serving stale code forever, because a browser only reinstalls a '
    + 'service worker when the worker script itself changes. Run `npm run pwa:rev`.')
})

test('every shipped file is either precached or explicitly excluded', async () => {
  const shell = await readShellList()
  const onDisk = await walkSite()
  assert.deepEqual(
    [...shell, ...SHELL_EXCLUDED].sort(),
    onDisk.sort(),
    'site/ and the service worker SHELL list have drifted apart',
  )
})

test('the service worker is a dependency-free classic script', async () => {
  const sw = stripComments(await text('sw.js'))
  assert.doesNotMatch(sw, /^\s*import\s/m, 'module service workers are not uniformly supported')
  assert.doesNotMatch(sw, /importScripts/, 'the shell worker should need no extra scripts')
  // Passing cross-origin requests through untouched is what keeps the YouTube
  // player, thumbnails and oEmbed out of the worker's hands entirely.
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/)
  assert.doesNotMatch(sw, /respondWith\(fetch\(request\)\)/,
    'a passthrough must return early, not reissue the request through the worker')
  // skipWaiting outside the message handler would swap assets under a live page.
  const skipWaitingCalls = [...sw.matchAll(/skipWaiting\(\)/g)]
  assert.equal(skipWaitingCalls.length, 1, 'skipWaiting belongs only in the message handler')
  assert.match(sw, /'SKIP_WAITING'\) void self\.skipWaiting\(\)/)
})

test('the manifest is installable from a repository subpath', async () => {
  const manifest = JSON.parse(await text('manifest.webmanifest'))

  assert.equal(manifest.start_url, './')
  assert.equal(manifest.scope, './')
  assert.ok(!('id' in manifest),
    'Omit id. Unlike start_url and scope it resolves against the ORIGIN, so "./" '
    + 'would claim the shared github.io account root, and a hardcoded '
    + '"/CourseTracker/" would be wrong under npm run dev. Omitted, it defaults '
    + 'to the processed start_url, which is correct on both.')
  assert.ok(!('orientation' in manifest),
    'locking orientation breaks fullscreen video rotation')

  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.short_name.length <= 12,
    'a longer short_name ellipsizes under a home-screen icon')

  const html = await text('index.html')
  const themeColor = html.match(/name="theme-color" content="([^"]+)"/)[1]
  assert.equal(manifest.theme_color, themeColor,
    'a manifest theme_color that disagrees with the meta tag flashes on launch')

  const purposes = manifest.icons.map((icon) => icon.purpose)
  assert.ok(purposes.includes('any') && purposes.includes('maskable'))
  assert.ok(purposes.every((purpose) => !purpose.includes(' ')),
    'one file serving both purposes looks shrunken as "any" or clipped as "maskable"')
})

test('the entry point links the manifest and the iOS icon with relative paths', async () => {
  const html = await text('index.html')
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/)
  // iOS takes the home-screen icon from this link, never from the manifest.
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\.\/icons\//)
  assert.doesNotMatch(html, /href="\/[^/]/, 'absolute paths break a repository subpath')
})

test('the CSP permits the manifest, which default-src none would otherwise block', async () => {
  const csp = (await text('index.html')).match(/Content-Security-Policy" content="([^"]+)"/)[1]
  assert.match(csp, /manifest-src 'self'/)
  assert.match(csp, /worker-src 'self'/)
})

test('every icon is a real PNG of the size the manifest promises', async () => {
  for (const { file, size, colorType } of ICONS) {
    const bytes = await readFile(join(SITE, 'icons', file))
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${file} is not a PNG`,
    )
    // IHDR is always the first chunk: 8 signature + 4 length + 4 type.
    assert.equal(bytes.readUInt32BE(16), size, `${file} width`)
    assert.equal(bytes.readUInt32BE(20), size, `${file} height`)
    assert.equal(bytes[25], colorType, `${file} colour type`)
  }
  // The Apple touch icon must have no alpha channel at all; iOS composites the
  // icon against black and applies its own squircle.
  const apple = ICONS.find((icon) => icon.file.startsWith('apple-touch-icon'))
  assert.equal(apple.colorType, RGB)
})

test('the maskable icon keeps its mark inside the safe circle', () => {
  // The safe zone is the inscribed circle of diameter 80%, not a central
  // square: a square's corners are clipped by circular launcher masks.
  const size = 512
  const pixels = renderMark(size, { rounded: false })
  const centre = size / 2
  const safeRadius = size * 0.4

  let furthestWhite = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      // The triangle is the only white content in the mark.
      if (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250) continue
      furthestWhite = Math.max(furthestWhite, Math.hypot(x + 0.5 - centre, y + 0.5 - centre))
    }
  }
  assert.ok(furthestWhite > 0, 'expected the play triangle to be drawn')
  assert.ok(furthestWhite <= safeRadius,
    `mark reaches ${furthestWhite.toFixed(1)}px from centre, past the ${safeRadius}px safe radius`)
})

test('a full-bleed icon has no transparent pixels to show through a mask', () => {
  const size = 64
  const pixels = renderMark(size, { rounded: false })
  for (let index = 3; index < pixels.length; index += 4) {
    assert.equal(pixels[index], 255, 'a full-bleed icon must be opaque to the edge')
  }
})

test('the PNG encoder emits a header the format actually defines', () => {
  const png = encodePng(renderMark(8), 8, 8, RGBA)
  assert.equal(png.readUInt32BE(16), 8)
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], RGBA)
  assert.equal(png[26], 0, 'compression method must be 0 (zlib deflate)')
  assert.equal(png[27], 0, 'filter method')
  assert.equal(png[28], 0, 'interlace method')
  assert.ok(png.includes(Buffer.from('IEND', 'latin1')))
})
