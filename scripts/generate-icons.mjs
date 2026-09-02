/**
 * Generates the PWA icon set from the same mark the favicon in index.html draws.
 *
 * The repo has no build step and no dependencies, so the PNGs are generated
 * once and committed. Regenerate with `npm run icons` after changing the mark.
 *
 * The encoder writes PNG by hand: signature, IHDR, IDAT, IEND, with a zlib
 * stream (deflateSync, not deflateRawSync) and a leading filter byte per
 * scanline. That is the whole format for what we need here.
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Colour types we emit. 6 is RGBA, 2 is RGB with no alpha channel at all. */
export const RGBA = 6
export const RGB = 2

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * @param {Uint8Array} pixels RGBA samples, 4 bytes per pixel, row-major.
 * @param {number} colorType RGBA to keep the alpha channel, RGB to drop it.
 */
export function encodePng(pixels, width, height, colorType = RGBA) {
  const channels = colorType === RGBA ? 4 : 3
  const raw = Buffer.alloc(height * (1 + width * channels))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter type 0 (None); the images are small and flat
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4
      raw[offset] = pixels[source]
      raw[offset + 1] = pixels[source + 1]
      raw[offset + 2] = pixels[source + 2]
      if (channels === 4) raw[offset + 3] = pixels[source + 3]
      offset += channels
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colorType
  // compression 0, filter 0, interlace 0 — the only values PNG defines.

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The mark, normalised from the favicon in site/index.html: a 64-unit viewBox
// with `rect rx=14` and `path M24 18l24 14-24 14z`.
const CORNER_RADIUS_RATIO = 14 / 64
const TRIANGLE = [[24 / 64, 18 / 64], [48 / 64, 32 / 64], [24 / 64, 46 / 64]]
const PURPLE = [0x7c, 0x4d, 0xff]
const WHITE = [0xff, 0xff, 0xff]

/** Samples per axis. 4 gives 16 coverage samples per pixel, plenty for flat shapes. */
const SUPERSAMPLE = 4

function insideRoundedRect(x, y, size, radius) {
  if (radius <= 0) return x >= 0 && y >= 0 && x <= size && y <= size
  if (x < 0 || y < 0 || x > size || y > size) return false
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function insideTriangle(x, y, points) {
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
  const [[x1, y1], [x2, y2], [x3, y3]] = points
  const d1 = sign(x, y, x1, y1, x2, y2)
  const d2 = sign(x, y, x2, y2, x3, y3)
  const d3 = sign(x, y, x3, y3, x1, y1)
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

/**
 * Draws the mark at `size` px.
 *
 * `rounded: false` produces a full-bleed square. That is what both the maskable
 * icon and the Apple touch icon need, because each platform applies its own
 * mask and a pre-rounded source shows corner artefacts inside it.
 *
 * The triangle is never rescaled for the maskable variant. A maskable safe zone
 * is the inscribed circle of diameter 80% (radius 0.4 x size), and the mark's
 * furthest vertex sits sqrt(128^2 + 64^2) ~ 143px from centre at 512, well
 * inside that 204.8px radius.
 */
export function renderMark(size, { rounded = true, opaque = false } = {}) {
  const pixels = new Uint8Array(size * size * 4)
  const radius = rounded ? size * CORNER_RADIUS_RATIO : 0
  const triangle = TRIANGLE.map(([tx, ty]) => [tx * size, ty * size])
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inShape = 0
      let inTriangle = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) * step
          const py = y + (sy + 0.5) * step
          if (!insideRoundedRect(px, py, size, radius)) continue
          inShape += 1
          if (insideTriangle(px, py, triangle)) inTriangle += 1
        }
      }

      const target = (y * size + x) * 4
      if (inShape === 0) {
        // Fully outside the rounded corner. Opaque icons never reach here
        // because their radius is 0 and every sample is inside.
        pixels[target] = opaque ? 0xff : 0
        pixels[target + 1] = opaque ? 0xff : 0
        pixels[target + 2] = opaque ? 0xff : 0
        pixels[target + 3] = opaque ? 0xff : 0
        continue
      }

      // Blend the triangle over the purple field by its own coverage, then let
      // the shape coverage drive alpha so the corners stay smooth.
      const triangleRatio = inTriangle / inShape
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[target + channel] = Math.round(
          PURPLE[channel] * (1 - triangleRatio) + WHITE[channel] * triangleRatio,
        )
      }
      pixels[target + 3] = opaque ? 0xff : Math.round((inShape / samples) * 255)
    }
  }
  return pixels
}

export const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, colorType: RGBA },
  { file: 'icon-512.png', size: 512, rounded: true, colorType: RGBA },
  // Full-bleed: Android crops this to whatever shape the launcher uses.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, colorType: RGBA },
  // iOS masks its own squircle and does not accept alpha, so this one is RGB.
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, colorType: RGB },
]

async function main() {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'icons')
  await mkdir(outDir, { recursive: true })
  for (const { file, size, rounded, colorType } of ICONS) {
    const pixels = renderMark(size, { rounded, opaque: colorType === RGB })
    const png = encodePng(pixels, size, size, colorType)
    await writeFile(join(outDir, file), png)
    console.log(`wrote site/icons/${file} (${size}x${size}, ${png.length} bytes)`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
