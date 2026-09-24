#!/usr/bin/env node
// Generates build/icon.png (512x512) using only built-in modules: a solid
// aperture-style mark (#ff7a2f on #121110). electron-builder derives the
// platform icons (.ico/.icns) from build/icon.png automatically.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SIZE = 512
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BG = [0x12, 0x11, 0x10]
const INK = [0xff, 0x7a, 0x2f]

function crc32(bytes) {
  let c = ~0
  for (const b of bytes) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 6 equally spaced notches at the inner ring rim → aperture blade look. */
function notchMask(angle) {
  const a = Math.abs((((angle + Math.PI / 6) % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6)
  return a < Math.PI / 40
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 3))
const center = SIZE / 2
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 3) // filter byte + RGB pixels
  raw[row] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - center
    const dy = y + 0.5 - center
    const r = Math.hypot(dx, dy)
    let ink = 0
    if (r >= 170 && r <= 215) ink = 1 // outer ring
    if (r <= 95) ink = 1 // inner hub
    if (ink && r >= 170 && r <= 195 && notchMask(Math.atan2(dy, dx))) ink = 0
    const [cr, cg, cb] = ink ? INK : BG
    const px = row + 1 + x * 3
    raw[px] = cr
    raw[px + 1] = cg
    raw[px + 2] = cb
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(path.join(ROOT, 'build'), { recursive: true })
const out = path.join(ROOT, 'build', 'icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
