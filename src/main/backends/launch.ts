// Backend launch specs: turn a model profile + resolved runtime paths into the
// executable, argv and environment SdServer spawns. Both backends speak the
// same native HTTP API once up; only the process launch differs. Deliberately
// electron-free so it is unit-testable.
import path from 'node:path'
import process from 'node:process'
import type { LocalBackendId, LocalModelProfile } from '@shared/types'
import { FLAG_BY_ID } from '@shared/sdcppFlags'
import { DIFFUSERS_FLAG_BY_ID } from '@shared/diffusersFlags'

/** Shell-like splitter: single/double quotes and backslash escapes. */
export function splitShellArgs(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let curIsQuoted = false
  let inSingle = false
  let inDouble = false
  const push = () => {
    if (curIsQuoted || cur.length > 0) tokens.push(cur)
    cur = ''
    curIsQuoted = false
  }
  const chars = [...input]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (inSingle) {
      // Everything is literal inside single quotes; only the quote itself acts.
      if (ch === "'") inSingle = false
      else cur += ch
      continue
    }
    if (ch === '\\') {
      const next = chars[i + 1]
      if (inDouble) {
        // Inside double quotes a backslash only escapes `"` or `\`; otherwise both
        // the backslash and the next character are literal.
        if (next === '"' || next === '\\') {
          cur += next
          i++
          continue
        }
        cur += ch
        continue
      }
      // Outside quotes a backslash only escapes a quote, backslash or whitespace;
      // anything else stays literal (so `C:\models\a.gguf` survives untouched).
      const escapable = next === '"' || next === "'" || next === '\\' || next === ' ' || next === '\t' || next === '\n' || next === '\r'
      if (next !== undefined && escapable) {
        cur += next
        if (next === '"' || next === "'") curIsQuoted = true
        i++
        continue
      }
      cur += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else cur += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      curIsQuoted = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      curIsQuoted = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push()
      continue
    }
    cur += ch
  }
  if (inSingle || inDouble) throw new Error('unterminated quote in extra args')
  push()
  return tokens
}

/**
 * Builds argv from a profile's `args` map, honouring only ids present in
 * `known` (see FLAG_BY_ID / DIFFUSERS_FLAG_BY_ID): bool true → `--<id>`;
 * bool false / '' / undefined → omitted; other values → `--<id> <value>`.
 */
export function buildFlagArgs(args: LocalModelProfile['args'], known: Map<string, unknown>): string[] {
  const out: string[] = []
  for (const [id, value] of Object.entries(args)) {
    if (!known.has(id)) continue // unknown keys are silently ignored
    if (typeof value === 'boolean') {
      if (value) out.push(`--${id}`)
      continue
    }
    if (value === undefined || value === '') continue
    out.push(`--${id}`, String(value))
  }
  return out
}

/**
 * Builds the sd-server argument vector for a launch profile + listen port.
 * Extra args are split and appended before the listen flags so they can't
 * move the server off the loopback port we poll.
 */
export function buildServerArgs(profile: LocalModelProfile, port: number): string[] {
  const args = buildFlagArgs(profile.args, FLAG_BY_ID)
  if (profile.extraArgs?.trim()) args.push(...splitShellArgs(profile.extraArgs))
  // Last so extra args can't move the server off the loopback port we poll.
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port))
  return args
}

/** Everything SdServer needs to spawn one backend instance. */
export interface LaunchSpec {
  backend: LocalBackendId
  /** Executable to spawn (sd-server binary or python interpreter). */
  command: string
  /** Full argv for a given listen port (must end with --listen-ip 127.0.0.1 --listen-port <port>). */
  argsFor(port: number): string[]
  cwd: string
  /** Extra env merged over process.env. */
  env?: Record<string, string>
  /** Human label for logs/errors: "sd-server" or "diffusers server". */
  label: string
  /** Files that must exist before spawning (command, script). */
  requiredFiles: string[]
  /** Last-moment check run synchronously right before spawning; throw to refuse the launch. */
  preflight?: () => void
}

/**
 * Freshly extracted sd.cpp builds keep shared libs next to the binary; make
 * sure the loader finds them (linux mac vulkan / rocm, and cuda-source builds).
 */
function sdcppEnv(binDir: string): Record<string, string> {
  const sep = process.platform === 'win32' ? ';' : ':'
  return {
    LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    PATH: [binDir, process.env.PATH].filter(Boolean).join(sep)
  }
}

/** Launch spec for the stable-diffusion.cpp `sd-server` binary. */
export function sdcppLaunch(serverPath: string, profile: LocalModelProfile): LaunchSpec {
  const binDir = path.dirname(serverPath)
  return {
    backend: 'sdcpp',
    command: serverPath,
    argsFor: (port) => buildServerArgs(profile, port),
    cwd: binDir,
    env: sdcppEnv(binDir),
    label: 'sd-server',
    requiredFiles: [serverPath]
  }
}

/** Launch spec for the bundled Python diffusers server (resources/diffusers/server.py). */
export function diffusersLaunch(opts: {
  pythonPath: string
  scriptPath: string
  profile: LocalModelProfile
  /** Hugging Face cache home; the server runs with HF_HUB_OFFLINE=1. */
  hfHome: string
  preflight?: () => void
}): LaunchSpec {
  const flagArgs = buildFlagArgs(opts.profile.args, DIFFUSERS_FLAG_BY_ID)
  const extraArgs = opts.profile.extraArgs?.trim() ? splitShellArgs(opts.profile.extraArgs) : []
  return {
    backend: 'diffusers',
    command: opts.pythonPath,
    argsFor: (port) => [
      opts.scriptPath,
      ...flagArgs,
      ...extraArgs,
      // Last so extra args can't move the server off the loopback port we poll.
      '--listen-ip',
      '127.0.0.1',
      '--listen-port',
      String(port)
    ],
    cwd: path.dirname(opts.scriptPath),
    env: {
      // Unbuffered so progress on stdout reaches the log promptly.
      PYTHONUNBUFFERED: '1',
      // Models come from the managed HF cache only; no network access at launch.
      HF_HUB_OFFLINE: '1',
      HF_HOME: opts.hfHome,
      PYTHONNOUSERSITE: '1',
      // UTF-8 stdio regardless of the Windows ANSI code page (non-ASCII user names in paths).
      PYTHONUTF8: '1',
      // Neutralize an activated conda/venv the app may have been launched from;
      // CPython treats empty values as unset.
      PYTHONHOME: '',
      PYTHONPATH: '',
      VIRTUAL_ENV: '',
      CONDA_PREFIX: '',
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True'
    },
    label: 'diffusers server',
    requiredFiles: [opts.pythonPath, opts.scriptPath],
    ...(opts.preflight ? { preflight: opts.preflight } : {})
  }
}
