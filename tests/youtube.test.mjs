import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalWatchUrl, isValidPlaylistId, isValidVideoId, loadYouTubeIframeApi, parsePlaylistId, safeThumbnailUrl, thumbnailUrl,
} from '../site/src/youtube.js'

test('extracts playlist ids from supported YouTube URL variants', () => {
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PL123'), 'PL123')
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=abc&list=PL123'), 'PL123')
  assert.equal(parsePlaylistId('https://youtu.be/abc?list=PL123'), 'PL123')
  assert.equal(parsePlaylistId('https://example.com/?list=PL123'), null)
  assert.equal(parsePlaylistId('https://youtube.com/watch?v=abc'), null)
})

test('playlist parsing rejects non-web schemes and malformed ids', () => {
  assert.equal(parsePlaylistId('ftp://www.youtube.com/playlist?list=PL123'), null)
  assert.equal(parsePlaylistId('javascript:alert(1)//www.youtube.com/?list=PL123'), null)
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PL1%3Cscript%3E'), null)
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=' + 'a'.repeat(200)), null)
  // Userinfo in the pasted URL is tolerated because only the id is kept.
  assert.equal(parsePlaylistId('http://user@www.youtube.com/playlist?list=PL123'), 'PL123')
})

test('identifier patterns admit only URL-safe base64', () => {
  assert.equal(isValidVideoId('dQw4w9WgXcQ'), true)
  assert.equal(isValidPlaylistId('PL_RUST'), true)
  assert.equal(isValidVideoId('a b'), false)
  assert.equal(isValidVideoId(''), false)
  assert.equal(isValidVideoId(42), false)
  assert.equal(isValidPlaylistId('PL<x>'), false)
  assert.equal(isValidPlaylistId('a'.repeat(129)), false)
})

test('thumbnail URLs are limited to https on YouTube image CDNs', () => {
  assert.equal(safeThumbnailUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg'), 'https://i.ytimg.com/vi/abc/hqdefault.jpg')
  assert.equal(safeThumbnailUrl('https://yt3.ggpht.com/avatar'), 'https://yt3.ggpht.com/avatar')
  assert.equal(safeThumbnailUrl('http://i.ytimg.com/vi/abc/hqdefault.jpg'), undefined)
  assert.equal(safeThumbnailUrl('https://evil.example/i.ytimg.com'), undefined)
  assert.equal(safeThumbnailUrl('https://ytimg.com.evil.example/x.jpg'), undefined)
  assert.equal(safeThumbnailUrl('javascript:alert(1)'), undefined)
  assert.equal(safeThumbnailUrl('not a url'), undefined)
  assert.equal(safeThumbnailUrl(42), undefined)
  assert.equal(safeThumbnailUrl(''), undefined)
})

test('generated watch URL keeps playlist context', () => {
  assert.equal(canonicalWatchUrl('video1', 'PL123'), 'https://www.youtube.com/watch?v=video1&list=PL123')
  assert.equal(thumbnailUrl('abc'), 'https://i.ytimg.com/vi/abc/hqdefault.jpg')
})


test('iframe API loader can retry after a script load failure', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let appended = 0
  globalThis.window = {}
  globalThis.document = {
    createElement() { return { async: false, src: '', onerror: null, remove() {} } },
    head: {
      appendChild(script) {
        appended += 1
        queueMicrotask(() => script.onerror?.())
      },
    },
  }

  try {
    await assert.rejects(loadYouTubeIframeApi(), /unable to load youtube iframe api/i)
    await assert.rejects(loadYouTubeIframeApi(), /unable to load youtube iframe api/i)
    assert.equal(appended, 2)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})
