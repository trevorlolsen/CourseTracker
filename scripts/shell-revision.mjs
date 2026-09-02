/**
 * Content-addresses the precached app shell.
 *
 * `node scripts/shell-revision.mjs` prints the revision the shell should carry.
 * `node scripts/shell-revision.mjs --write` rewrites the SHELL_REVISION literal
 * in site/sw.js. tests/pwa.test.mjs asserts the two agree, which is what stops
 * an asset edit from shipping without a worker update.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site')
export const SW_PATH = join(SITE, 'sw.js')

const REVISION_PATTERN = /const SHELL_REVISION = '([0-9a-f]*)'/

/** Reads the SHELL array out of sw.js without executing it. */
export async function readShellList(source) {
  const text = source ?? await readFile(SW_PATH, 'utf8')
  const block = text.match(/const SHELL = \[([\s\S]*?)\n\]/)
  if (!block) throw new Error('Could not find the SHELL array in sw.js')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

export function readDeclaredRevision(source) {
  const match = source.match(REVISION_PATTERN)
  if (!match) throw new Error('Could not find SHELL_REVISION in sw.js')
  return match[1]
}

/**
 * Hashes each shell file's path and contents in a stable order. sw.js itself is
 * excluded: it is the file the revision gets written into, so including it
 * would never converge.
 *
 * Text files are normalised to LF first. Git rewrites line endings on checkout
 * (core.autocrlf), so hashing raw bytes would make the revision depend on which
 * platform ran the command, and CI on Linux would disagree with a Windows
 * clone about a file neither of them changed.
 */
export async function computeRevision(paths) {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    const bytes = await readFile(join(SITE, path.replace(/^\.\//, '')))
    hash.update(path)
    hash.update('\0')
    hash.update(path.endsWith('.png') ? bytes : normalizeNewlines(bytes))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

function normalizeNewlines(bytes) {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

async function main() {
  const source = await readFile(SW_PATH, 'utf8')
  const revision = await computeRevision(await readShellList(source))
  if (!process.argv.includes('--write')) {
    console.log(revision)
    return
  }
  const updated = source.replace(REVISION_PATTERN, `const SHELL_REVISION = '${revision}'`)
  await writeFile(SW_PATH, updated)
  console.log(`SHELL_REVISION = ${revision}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
