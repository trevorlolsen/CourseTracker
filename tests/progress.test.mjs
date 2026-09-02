import test from 'node:test'
import assert from 'node:assert/strict'
import { isMassRemoval, resolveProgressUpdate, shouldAutoComplete } from '../site/src/domain.js'

const video = (overrides = {}) => ({
  videoId: 'v1', watched: false, resumeSeconds: 0, durationSeconds: undefined, ...overrides,
})
const snap = (overrides = {}) => ({
  videoId: 'v1', currentTime: 0, duration: 100, state: 'playing', ...overrides,
})

test('a snapshot for a different lesson is never persisted', () => {
  const result = resolveProgressUpdate({ snapshot: snap({ videoId: 'other' }), video: video() })
  assert.equal(result.persist, false)
})

test('cued and buffering snapshots are ignored', () => {
  for (const state of ['cued', 'buffering', 'unstarted']) {
    assert.equal(resolveProgressUpdate({ snapshot: snap({ state }), video: video() }).persist, false)
  }
})

test('a playing snapshot records the live position without completing', () => {
  const result = resolveProgressUpdate({ snapshot: snap({ currentTime: 270, duration: 600 }), video: video(), now: 5 })
  assert.equal(result.persist, true)
  assert.deepEqual(result.patch, { watched: false, resumeSeconds: 270, progressUpdatedAt: 5 })
  assert.equal(result.watchedChanged, false)
})

test('crossing 95 percent completes the lesson and reports the change', () => {
  const result = resolveProgressUpdate({ snapshot: snap({ currentTime: 96, state: 'paused' }), video: video(), now: 1 })
  assert.equal(result.patch.watched, true)
  assert.equal(result.watchedChanged, true, 'the screen must be told to update')
})

test('an already watched lesson reports no change when it completes again', () => {
  const result = resolveProgressUpdate({ snapshot: snap({ currentTime: 99, state: 'ended' }), video: video({ watched: true }) })
  assert.equal(result.patch.watched, true)
  assert.equal(result.watchedChanged, false)
})

test('suppression keeps a manually unwatched lesson unwatched through the end', () => {
  const result = resolveProgressUpdate({
    snapshot: snap({ currentTime: 100, state: 'ended' }),
    video: video({ resumeSeconds: 99 }),
    suppressAutoComplete: true,
  })
  assert.equal(result.patch.watched, false)
  assert.equal(result.patch.resumeSeconds, 100)
})

test('suppression never un-watches a lesson the user marked watched', () => {
  const result = resolveProgressUpdate({
    snapshot: snap({ currentTime: 100, state: 'ended' }),
    video: video({ watched: true }),
    suppressAutoComplete: true,
  })
  assert.equal(result.patch.watched, true)
})

test('a negative or missing current time is clamped', () => {
  const result = resolveProgressUpdate({ snapshot: snap({ currentTime: -5, state: 'paused' }), video: video() })
  assert.equal(result.patch.resumeSeconds, 0)
})

test('duration is only reported when it is new and usable', () => {
  assert.equal(resolveProgressUpdate({ snapshot: snap({ duration: 0 }), video: video() }).durationSeconds, undefined)
  assert.equal(resolveProgressUpdate({ snapshot: snap({ duration: 600 }), video: video() }).durationSeconds, 600)
  assert.equal(
    resolveProgressUpdate({ snapshot: snap({ duration: 600 }), video: video({ durationSeconds: 600 }) }).durationSeconds,
    undefined,
  )
})

test('an unknown duration cannot auto-complete a lesson', () => {
  assert.equal(shouldAutoComplete({ currentTime: 5000, duration: 0, ended: false }), false)
  assert.equal(shouldAutoComplete({ currentTime: 5000, duration: NaN, ended: false }), false)
})

test('mass removal only trips on a large proportional loss', () => {
  assert.equal(isMassRemoval({ removed: 3 }, 10), false, 'small removals are ordinary edits')
  assert.equal(isMassRemoval({ removed: 6 }, 40), false, 'six of forty is a plausible edit')
  assert.equal(isMassRemoval({ removed: 36 }, 40), true, 'a truncated playlist must be confirmed')
  assert.equal(isMassRemoval({ removed: 0 }, 0), false)
})
