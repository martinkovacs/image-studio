#!/usr/bin/env node
// Integration smoke test for sd-server + the SdServer contract.
// Not part of vitest. Usage:
//   node scripts/smoke-sdserver.mjs <path-to-sd-server> [--model <path>]
// Without --model it only verifies startup + capabilities; with --model it also
// generates one small image.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [binArg, , modelArgRaw] = process.argv.slice(2)
const modelIdx = process.argv.indexOf('--model')
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : null
const bin = binArg
if (!bin || !existsSync(bin) || !statSync(bin).isFile()) {
  console.error('usage: node scripts/smoke-sdserver.mjs <path-to-sd-server> [--model <path>]')
  process.exit(1)
}
const port = Number(process.env.SMOKE_PORT ?? 42317)
const dir = path.dirname(bin)
const env = {
  ...process.env,
  LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
}
const flags = []
if (model) {
  flags.unshift('--model', model)
} else {
  // Without a model sd-server refuses to start; --help still proves it runs.
  flags.splice(0, flags.length)
  flags.push('--help')
}
console.log(`spawning ${bin} ${flags.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(' ')}`)
const child = spawn(bin, flags, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
let tail = []
child.stdout.on('data', (b) => {
  for (const line of b.toString('utf8').split(/\r\n|\r|\n/)) {
    if (line.trim()) tail.push(line)
    if (tail.length > 4000) tail.shift()
  }
})
child.stderr.on('data', (b) => console.error('[stderr]', b.toString('utf8').trim()))
if (!model) {
  const code = await new Promise((resolve) => child.once('exit', resolve))
  await new Promise((r) => setTimeout(r, 200)) // let stdout flush
  const ok = code === 0 && tail.some((l) => /Usage/i.test(l))
  console.log(ok ? '✔ smoke test ok (binary runs, prints usage)' : `✘ --help exited with ${code}`)
  process.exit(ok ? 0 : 1)
}

async function waitReady(timeoutMs) {
  const base = `http://127.0.0.1:${port}`
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child.exitCode !== null) {
      console.error(`exit ${child.exitCode}\nlast log:\n${tail.join('\n')}`)
      process.exit(1)
    }
    try {
      const res = await fetch(`${base}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return JSON.parse(await res.text())
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error('timeout while waiting for capabilities')
  process.exit(1)
}

const caps = await waitReady(60_000)
console.log('model:', caps.model?.name)
console.log('supported_modes:', caps.supported_modes)
console.log('samplers:', caps.samplers?.length)
console.log('upscalers:', caps.upscalers?.map((u) => u.name))
const req = { prompt: 'a red apple on a table', width: 256, height: 256, batch_count: 1 }
const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/img_gen`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(req)
})
if (!res.ok) {
  console.error(`smokegen failed: HTTP ${res.status} ${await res.text()}`)
  process.exit(1)
}
const job = await res.json()
console.log('img_gen submitted:', job.id, 'poll_url:', job.poll_url)
let poll
while (!poll || !['completed', 'failed', 'cancelled'].includes(poll.status)) {
  await new Promise((r) => setTimeout(r, 400))
  poll = (await (await fetch(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${job.id}`)).json())
  if (poll.status === 'generating' || poll.status === 'queued') process.stdout.write(`.[${poll.status}]`)
}
console.log()
if (poll.status !== 'completed') {
  console.error('img_gen failed:', JSON.stringify(poll.error))
  process.exit(1)
}
console.log('image bytes:', poll.result.images[0].b64_json.length)
child.kill('SIGTERM')
