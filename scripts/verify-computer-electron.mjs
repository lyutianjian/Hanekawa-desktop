#!/usr/bin/env node
import { app, powerMonitor, shell, systemPreferences } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const profile = mkdtempSync(join(tmpdir(), 'hanekawa-computer-probe-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)

// Let the entry module finish loading before waiting for Electron readiness.
app.whenReady().then(async () => {
  let host
  let unwatch
  let exitCode = 0
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => !['--request-accessibility', '--verify-lifecycle'].includes(arg))) throw new Error('Only --request-accessibility and --verify-lifecycle are accepted')
    if (args.includes('--request-accessibility')) {
      if (process.platform !== 'darwin') throw new Error('Accessibility authorization requires macOS')
      const trusted = systemPreferences.isTrustedAccessibilityClient(true)
      console.log(JSON.stringify({ authorizationRequested: true, executable: app.getPath('exe'), accessibility: trusted }))
      if (!trusted) {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
        shell.showItemInFolder(dirname(dirname(dirname(app.getPath('exe')))))
        console.log('Waiting up to 120 seconds for Accessibility. macOS may attribute a development process to its launching app or terminal; if Electron is enabled but the helper remains untrusted, check that launcher too. No further prompts will be requested.')
        const end = performance.now() + 120000
        while (performance.now() < end && !systemPreferences.isTrustedAccessibilityClient(false)) await delay(1000)
      }
    }
    const { DesktopComputerHost } = await import('../dist/desktop/computer/host.js')
    host = new DesktopComputerHost({ executable: fileURLToPath(new URL('../dist/desktop/computer/native/hanekawa-computer', import.meta.url)) })
    const response = await host.run({ sessionId: 'computer-probe', input: { operation: 'status' }, timeoutMs: 5000 })
    const lifecycleChecks = []
    if (args.includes('--verify-lifecycle')) {
      const { watchComputerDesktop } = await import('../dist/desktop/computer/lifecycle.js')
      unwatch = watchComputerDesktop(host, powerMonitor)
      const status = () => host.run({ sessionId: 'computer-probe', input: { operation: 'status' }, timeoutMs: 5000 })
      // These are synthetic EventEmitter notifications in this isolated process.
      // They do not lock, unlock or sleep the user's desktop.
      powerMonitor.emit('lock-screen')
      await assert.rejects(status(), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
      lifecycleChecks.push('injected lock-screen blocks dispatch')
      powerMonitor.emit('suspend')
      powerMonitor.emit('unlock-screen')
      await assert.rejects(status(), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
      lifecycleChecks.push('injected unlock does not clear suspend')
      powerMonitor.emit('resume')
      assert.equal((await status()).envelope.ok, true)
      lifecycleChecks.push('injected resume rechecks real idle state and permits fresh status')
    }
    console.log(JSON.stringify({ scope: 'Isolated Electron main -> production host -> native helper; not full Hanekawa GUI acceptance',
      electron: process.versions.electron, response, ...(lifecycleChecks.length ? { lifecycleChecks, lifecycleScope: 'Synthetic powerMonitor events; no real OS suspend or lock performed' } : {}) }))
  } catch (error) {
    console.error(`[verify-computer-electron] FAILED (run npm run build:desktop first): ${error?.message ?? error}`)
    exitCode = 1
  } finally {
    unwatch?.()
    await host?.dispose()
    rmSync(profile, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
