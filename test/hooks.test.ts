import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLifecycleHooks } from '../src/harness/hooks.js'

test('hook timeout and cancellation kill descendants even after the shell exits', { skip: process.platform === 'win32' }, async () => {
  for (const parentExits of [false, true]) {
    for (const cancel of [false, true]) {
      const cwd = await mkdtemp(join(tmpdir(), 'hook-tree-'))
      const ac = new AbortController()
      const marker = join(cwd, 'leaked')
      const command = `( (sleep 0.7; echo leaked > '${marker}') & wait ) & ${parentExits ? 'exit 0' : 'wait'}`
      const started = Date.now()
      const pending = runLifecycleHooks([{ command, timeoutMs: 50 }], 'stop', {}, { cwd, sessionId: 's', readFiles: new Set() }, ac.signal)
      const timer = cancel ? setTimeout(() => ac.abort('user-cancel'), 30) : undefined
      try {
        if (cancel) await assert.rejects(pending, { name: 'AbortError' })
        else assert.match((await pending).failures.join(''), /timed out/)
        assert.ok(Date.now() - started < 600, 'return without waiting for the descendant')
        await new Promise((resolve) => setTimeout(resolve, 750))
        await assert.rejects(readFile(marker), { code: 'ENOENT' })
      } finally {
        clearTimeout(timer)
        await rm(cwd, { recursive: true, force: true })
      }
    }
  }
})

test('hooks finish normally and report spawn errors without a pending wait', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hook-normal-'))
  const context = { cwd, sessionId: 's', readFiles: new Set<string>() }
  try {
    assert.equal((await runLifecycleHooks([{ command: 'echo done' }], 'stop', {}, context)).stdout, 'done')
    await rm(cwd, { recursive: true, force: true })
    assert.match((await runLifecycleHooks([{ command: 'echo done' }], 'stop', {}, context)).failures.join(''), /ENOENT/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('POSIX hooks force-kill descendants that ignore TERM, including orphaned children', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async () => {
  for (const parentExits of [false, true]) {
    for (const cancel of [false, true]) {
      const cwd = await mkdtemp(join(tmpdir(), 'hook-force-'))
      const controller = new AbortController()
      let pid: number | undefined
      let outcome: Promise<unknown> | undefined
      try {
        await writeFile(join(cwd, 'worker.cjs'), `
          const fs = require('node:fs');
          process.on('SIGTERM', () => fs.writeFileSync('term', 'received'));
          fs.writeFileSync('worker.pid', String(process.pid));
          setInterval(() => {}, 1000);
        `)
        const pending = runLifecycleHooks([{
          command: `"${process.execPath}" worker.cjs & ${parentExits ? 'exit 0' : 'wait'}`, timeoutMs: 2_000,
        }], 'stop', {}, { cwd, sessionId: 'force', readFiles: new Set() }, controller.signal)
        outcome = pending.then((result) => result, (error: unknown) => error)
        for (let poll = 0; poll < 150; poll++) {
          const contents = await readFile(join(cwd, 'worker.pid'), 'utf8').catch(() => '')
          if (contents) { pid = Number(contents); break }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.ok(pid, 'the worker installs its TERM handler before cancellation or timeout')
        if (cancel) controller.abort()
        const result = await outcome
        if (cancel) assert.ok(result instanceof Error && result.name === 'AbortError')
        else assert.match((result as { failures: string[] }).failures.join(''), /timed out/)
        assert.equal(await readFile(join(cwd, 'term'), 'utf8'), 'received')
        for (let poll = 0; poll < 60 && isAlive(pid); poll++) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.equal(isAlive(pid), false, 'ignoring TERM must not survive the force-kill phase')
      } finally {
        controller.abort()
        await outcome
        if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
        await rm(cwd, { recursive: true, force: true })
      }
    }
  }
})

test('Windows hooks kill orphaned grandchildren through the job when cancelled or timed out', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async () => {
  for (const parentExits of [false, true]) {
    for (const cancel of [false, true]) {
      const cwd = await mkdtemp(join(tmpdir(), 'hook-windows-job-'))
      const pidFile = join(cwd, 'grandchild.pid')
      const controller = new AbortController()
      let pid: number | undefined
      let outcome: Promise<unknown> | undefined
      try {
        await writeFile(join(cwd, 'worker.cjs'), `
          require('node:fs').writeFileSync('grandchild.pid', String(process.pid));
          process.on('SIGTERM', () => {});
          setInterval(() => {}, 1000);
        `)
        await writeFile(join(cwd, 'middle.cjs'), `
          require('node:child_process').spawn(process.execPath, ['worker.cjs'], { stdio: 'inherit', windowsHide: true });
          ${parentExits ? 'process.exit(0)' : ''}
        `)
        await writeFile(join(cwd, 'parent.cjs'), `
          require('node:child_process').spawn(process.execPath, ['middle.cjs'], { stdio: 'inherit', windowsHide: true });
          ${parentExits ? 'process.exit(0)' : ''}
        `)
        const pending = runLifecycleHooks([
          { command: `"${process.execPath}" parent.cjs`, timeoutMs: 10_000 },
        ], 'stop', {}, { cwd, sessionId: 'windows-job', readFiles: new Set() }, controller.signal)
        outcome = pending.then((result) => result, (error: unknown) => error)
        for (let poll = 0; poll < 160; poll++) {
          const contents = await readFile(pidFile, 'utf8').catch(() => '')
          if (contents) { pid = Number(contents); break }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.ok(pid, `the grandchild must actually start before ${cancel ? 'cancellation' : 'timeout'}`)
        if (parentExits) await new Promise((resolve) => setTimeout(resolve, 150))
        const cancelledAt = Date.now()
        if (cancel) controller.abort()
        const result = await outcome
        if (cancel) {
          assert.ok(result instanceof Error && result.name === 'AbortError')
          assert.ok(Date.now() - cancelledAt < 3_000)
        } else {
          assert.ok(!(result instanceof Error))
          assert.match((result as { failures: string[] }).failures.join(''), /timed out/)
        }
        for (let poll = 0; poll < 60 && isAlive(pid); poll++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(isAlive(pid), false, 'the job must kill the actual grandchild after its ancestors exit')
      } finally {
        controller.abort()
        await outcome
        if (pid && isAlive(pid)) {
          try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
        }
        await rm(cwd, { recursive: true, force: true })
      }
    }
  }
})

test('Windows hook jobs preserve stdin, stdout, stderr and the shell exit code', { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hook-windows-io-'))
  try {
    await writeFile(join(cwd, 'io.cjs'), `
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        console.log(JSON.parse(input).sessionId);
        console.error('hook-stderr');
        process.exitCode = 7;
      });
    `)
    const result = await runLifecycleHooks([{ command: `"${process.execPath}" io.cjs` }], 'stop', {}, {
      cwd, sessionId: 'job-stdin', readFiles: new Set(),
    })
    assert.match(result.stdout, /job-stdin/)
    assert.match(result.failures.join(''), /code 7/)
    assert.match(result.failures.join(''), /hook-stderr/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
