import test from 'node:test'
import assert from 'node:assert/strict'
import { runLimited } from '../site/src/async.js'

test('runLimited never exceeds the requested concurrency and processes every value', async () => {
  let active = 0
  let maxActive = 0
  const seen = []
  const values = [1, 2, 3, 4, 5, 6]

  const results = await runLimited(values, 2, async (value) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    seen.push(value)
    active -= 1
    return value * 10
  })

  assert.equal(maxActive, 2)
  assert.deepEqual(seen.toSorted((a, b) => a - b), values)
  assert.deepEqual(results.map((result) => result.value).toSorted((a, b) => a - b), [10, 20, 30, 40, 50, 60])
})

test('runLimited isolates worker failures and reports them without stopping the batch', async () => {
  const results = await runLimited([1, 2, 3], 2, async (value) => {
    if (value === 2) throw new Error('boom')
    return value
  })

  assert.equal(results.length, 3)
  assert.deepEqual(results.filter((result) => result.status === 'fulfilled').map((result) => result.value).sort(), [1, 3])
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /boom/)
})
