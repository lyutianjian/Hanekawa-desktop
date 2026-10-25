import { spawn, type ChildProcess } from 'node:child_process'

const FORCE_KILL_DELAY_MS = 5_000
const WINDOWS_GRACE_MS = 250
const FINAL_WAIT_MS = 1_000

export async function terminateProcessTree(proc: ChildProcess, options: { graceMs?: number } = {}): Promise<void> {
  if (process.platform === 'win32') {
    if (!isProcessRunning(proc)) return
    await runTaskkill(proc.pid, false)
    if (await waitForExit(proc, WINDOWS_GRACE_MS)) return
    await runTaskkill(proc.pid, true)
    if (await waitForExit(proc, FINAL_WAIT_MS)) return
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
    return
  }

  signalProcessGroup(proc, 'SIGTERM')
  const deadline = Date.now() + (options.graceMs ?? FORCE_KILL_DELAY_MS)
  while (isProcessGroupRunning(proc)) {
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!isProcessGroupRunning(proc)) return
  signalProcessGroup(proc, 'SIGKILL')
  await waitForExit(proc, FINAL_WAIT_MS)
}

function isProcessGroupRunning(proc: ChildProcess): boolean {
  if (!proc.pid) return false
  try { process.kill(-proc.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function isProcessRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

function signalProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (proc.pid) process.kill(-proc.pid, signal)
    else proc.kill(signal)
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

async function runTaskkill(pid: number | undefined, force: boolean): Promise<void> {
  if (!pid) return
  await new Promise<void>((resolve) => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
    const killer = spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => resolve())
    killer.once('close', () => resolve())
  })
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isProcessRunning(proc)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    const onClose = () => finish(true)
    const finish = (exited: boolean) => {
      clearTimeout(timeout)
      proc.removeListener('close', onClose)
      resolve(exited)
    }
    proc.once('close', onClose)
  })
}
