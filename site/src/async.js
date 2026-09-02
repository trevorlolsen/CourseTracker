export async function runLimited(values, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
  const items = Array.from(values)
  const results = new Array(items.length)
  let nextIndex = 0

  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const runnerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: runnerCount }, () => runner()))
  return results
}
