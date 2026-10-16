// Hardware probe (GPU detection) and the default local backend choice. Pure
// helpers (the nvidia-smi CSV parser, chooseBackend) are exported separately
// from the process-dependent probe so they are unit-testable.
import os from 'node:os'
import process from 'node:process'
import { spawn } from 'node:child_process'
import type { BackendInfo, BackendPreference, GpuInfo, HardwareInfo, LocalBackendId } from '@shared/types'

const PROBE_TIMEOUT_MS = 5000
const NVIDIA_SMI_ARGS = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']
const NVIDIA_SMI_WIN_PATH = 'C:\\Windows\\System32\\nvidia-smi.exe'

export interface ProbeRunResult {
  /** Exit code, null on spawn error or timeout. */
  code: number | null
  stdout: string
}
/** Injectable probe runner (default spawns a real command with a timeout). */
export type ProbeRun = (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeRunResult>

// --- pure helpers -----------------------------------------------------------

/** Parses `nvidia-smi --format=csv,noheader,nounits` output. Junk lines are skipped; '[N/A]' memory → vramMiB null. */
export function parseNvidiaSmi(csv: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 2 || !parts[0]) continue
    const [name, memory, driver] = parts
    const hasMemory = /^\d+$/.test(memory)
    const isNa = /^\[?n\/a\]?$/i.test(memory)
    if (!hasMemory && !isNa) continue
    const cleanDriver = driver && !/^\[?n\/a\]?$/i.test(driver) ? driver : undefined
    gpus.push({
      vendor: 'nvidia',
      name,
      vramMiB: hasMemory ? Number(memory) : null,
      ...(cleanDriver ? { driver: cleanDriver } : {})
    })
  }
  return gpus
}

/** True when the diffusers runtime (PyTorch CUDA wheels) can exist on this platform. */
export function diffusersSupportedOn(platform: string, arch: string): boolean {
  return (platform === 'linux' || platform === 'win32') && arch === 'x64'
}

/** Resolves preference + auto-detected choice into a BackendInfo. Pure. */
export function chooseBackend(hw: HardwareInfo, pref: BackendPreference): BackendInfo {
  const diffusersSupported = diffusersSupportedOn(hw.platform, hw.arch)
  const nvidia = hw.gpus.filter((g) => g.vendor === 'nvidia')
  const best = nvidia
    .filter((g): g is GpuInfo & { vramMiB: number } => g.vramMiB !== null && g.vramMiB >= 6000)
    .sort((a, b) => b.vramMiB - a.vramMiB)[0]
  let autoChoice: LocalBackendId
  let reason: string
  if (!diffusersSupported) {
    autoChoice = 'sdcpp'
    reason = 'Diffusers (CUDA PyTorch) is not supported on this platform — using stable-diffusion.cpp'
  } else if (best) {
    autoChoice = 'diffusers'
    reason = `${best.name} (${Math.round(best.vramMiB / 1024)} GB) detected — using diffusers`
  } else if (nvidia.length > 0) {
    autoChoice = 'sdcpp'
    reason = 'NVIDIA GPU has under 6 GB VRAM — using stable-diffusion.cpp'
  } else {
    autoChoice = 'sdcpp'
    reason = 'No NVIDIA GPU detected — using stable-diffusion.cpp'
  }
  return {
    preference: pref,
    autoChoice,
    effective: pref === 'auto' ? autoChoice : pref,
    reason,
    hardware: hw,
    diffusersSupported
  }
}

/** NVIDIA-only GPU probe for a platform (macOS never has nvidia-smi); best-effort, never throws. */
export async function probeNvidiaGpus(platform: NodeJS.Platform, run: ProbeRun): Promise<GpuInfo[]> {
  if (platform !== 'linux' && platform !== 'win32') return []
  const mustSucceed = (res: ProbeRunResult): boolean => (res.code ?? 1) === 0 && res.stdout.trim().length > 0
  let res = await run('nvidia-smi', NVIDIA_SMI_ARGS, PROBE_TIMEOUT_MS)
  if (!mustSucceed(res) && platform === 'win32') {
    res = await run(NVIDIA_SMI_WIN_PATH, NVIDIA_SMI_ARGS, PROBE_TIMEOUT_MS)
  }
  return mustSucceed(res) ? parseNvidiaSmi(res.stdout) : []
}

// --- probe (process-dependent) ---------------------------------------------

/** Spawn-based probe run; never rejects. A timeout kills the process (code null). */
function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<ProbeRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve({ code: null, stdout: '' })
      return
    }
    let stdout = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

let hardwareCache: HardwareInfo | null = null

/**
 * Probes the machine: platform/arch/RAM always, NVIDIA GPUs via nvidia-smi
 * (Windows also tries the system path), Apple Silicon on macOS arm64.
 * Cached in module scope; `refresh: true` re-probes. Never throws.
 */
export async function probeHardware(opts: { run?: ProbeRun, refresh?: boolean } = {}): Promise<HardwareInfo> {
  if (hardwareCache && !opts.refresh) return hardwareCache
  const run = opts.run ?? defaultRun
  let gpus: GpuInfo[] = []
  try {
    if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        gpus = [{ vendor: 'apple', name: 'Apple Silicon', vramMiB: null }]
      }
    } else if (process.platform === 'linux' || process.platform === 'win32') {
      gpus = await probeNvidiaGpus(process.platform, run)
    }
  } catch {
    // Best-effort: an empty GPU list is better than a crash.
  }
  const info: HardwareInfo = {
    platform: process.platform,
    arch: process.arch,
    ramMiB: Math.round(os.totalmem() / (1024 * 1024)),
    gpus
  }
  hardwareCache = info
  return info
}
