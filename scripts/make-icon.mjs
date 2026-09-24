#!/usr/bin/env node
// Generates build/icon.png (512x512) and build/icon.ico (256x256,
// PNG-compressed single entry) using only built-in modules: a solid
// aperture-style mark (#ff7a2f on #121110). The .ico is used for the Windows
// exe and Squirrel installer; .png covers the remaining platform icons.
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

/** Renders the aperture mark as an RGB PNG buffer at the given size. */
function renderPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 3))
  const center = size / 2
  // Ring radii, scaled with the canvas.
  const outerIn = (170 / 512) * size
  const outerOut = (215 / 512) * size
  const hub = (95 / 512) * size
  const notchOuter = (195 / 512) * size
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3) // filter byte + RGB pixels
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center
      const dy = y + 0.5 - center
      const r = Math.hypot(dx, dy)
      let ink = 0
      if (r >= outerIn && r <= outerOut) ink = 1 // outer ring
      if (r <= hub) ink = 1 // inner hub
      if (ink && r >= outerIn && r <= notchOuter && notchMask(Math.atan2(dy, dx))) ink = 0
      const [cr, cg, cb] = ink ? INK : BG
      const px = row + 1 + x * 3
      raw[px] = cr
      raw[px + 1] = cg
      raw[px + 2] = cb
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * ICO wrapping a single 256x256 PNG-compressed entry: 6-byte ICONDIR
 * (reserved=0, type=1, count=1) + 16-byte ICONDIRENTRY, then the PNG bytes.
 * Width/height bytes are 0, which is the convention for 256.
 */
function buildIco(pngBytes) {
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width = 256
  entry[1] = 0 // height = 256
  entry[2] = 1 // color count (palette); ignored for PNG entries
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(pngBytes.length, 8) // data size
  entry.writeUInt32LE(22, 12) // data offset (6 + 16)
  return Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), entry, pngBytes])
}

mkdirSync(path.join(ROOT, 'build'), { recursive: true })
const outPng = path.join(ROOT, 'build', 'icon.png')
writeFileSync(outPng, renderPng(SIZE))
console.log(`wrote ${outPng}`)
const icoPng = renderPng(256)
const outIco = path.join(ROOT, 'build', 'icon.ico')
writeFileSync(outIco, buildIco(icoPng))
console.log(`wrote ${outIco} (${icoPng.length} byte PNG entry)`)
