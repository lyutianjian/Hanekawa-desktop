import test from 'node:test'
import assert from 'node:assert/strict'
import { PowerSaveController, type WorkActivity } from '../src/desktop/powerSave.js'
import { ProjectDirectory, type DirectoryProject, type DirectoryWorkspace } from '../src/runtime/projectDirectory.js'
import { BackgroundTaskRegistry } from '../src/services/backgroundTasks/registry.js'

function activity(initial = false) {
  let active = initial
  const listeners = new Set<() => void>()
  return {
    isActive: () => active,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(value: boolean) { active = value; for (const listener of listeners) listener() },
    listeners,
  }
}

function harness() {
  const calls: Array<string | number> = []
  const logs: string[] = []
  let next = 0
  const controller = new PowerSaveController({
    start(type) { calls.push(type); return next++ },
    stop(id) { calls.push(id) },
  }, (message) => logs.push(message))
  return { controller, calls, logs }
}

test('one blocker including ID zero covers overlapping lanes and background work', () => {
  const { controller, calls } = harness()
  const a = activity(), b = activity(), background = activity()
  const offA = controller.watch(a, a)
  controller.watch(b, b)
  controller.watch(background, background)
  assert.deepEqual(calls, [])
  a.set(true)
  a.set(true)
  b.set(true)
  background.set(true)
  a.set(false)
  offA()
  b.set(false)
  assert.deepEqual(calls, ['prevent-app-suspension'])
  background.set(false)
  background.set(false)
  assert.deepEqual(calls, ['prevent-app-suspension', 0])
  controller.dispose()
  controller.dispose()
  assert.equal(b.listeners.size, 0)
  assert.equal(background.listeners.size, 0)
})

test('watch reads current activity; resume re-reads sources and renews only active work', () => {
  const { controller, calls } = harness()
  const source = activity(true)
  controller.watch(source, source)
  controller.resume()
  assert.deepEqual(calls, ['prevent-app-suspension', 0, 'prevent-app-suspension'])
  source.set(false)
  controller.resume()
  assert.deepEqual(calls, ['prevent-app-suspension', 0, 'prevent-app-suspension', 1])
  source.set(true)
  controller.dispose()
  source.set(true)
  controller.resume()
  controller.watch({}, activity(true))
  assert.deepEqual(calls.slice(-2), ['prevent-app-suspension', 2])
})

test('resume detects a source that changed without emitting', () => {
  const { controller, calls } = harness()
  let active = true
  const source: WorkActivity = { isActive: () => active, subscribe: () => () => {} }
  controller.watch(source, source)
  active = false
  controller.resume()
  assert.deepEqual(calls, ['prevent-app-suspension', 0])
  controller.dispose()
})

test('disabling releases active work immediately; enabling rechecks current work', () => {
  const { controller, calls } = harness()
  const source = activity(true)
  controller.setEnabled(false)
  controller.watch(source, source)
  controller.resume()
  assert.deepEqual(calls, [])
  controller.setEnabled(true)
  controller.setEnabled(true)
  controller.setEnabled(false)
  controller.resume()
  source.set(false)
  controller.setEnabled(true)
  assert.deepEqual(calls, ['prevent-app-suspension', 0])
  source.set(true)
  controller.setEnabled(false)
  controller.dispose()
  assert.deepEqual(calls, ['prevent-app-suspension', 0, 'prevent-app-suspension', 1])
})

test('start/stop failures do not break tasks or retry on repeated progress', () => {
  let starts = 0, stops = 0, failures = 0
  const source = activity()
  const controller = new PowerSaveController({
    start() { if (++starts === 1) throw new Error('start'); return 0 },
    stop() { if (++stops === 1) throw new Error('stop') },
  }, (_message, error) => { if (error) failures++ })
  controller.watch(source, source)
  source.set(true)
  source.set(true)
  assert.equal(starts, 1)
  controller.resume()
  assert.equal(starts, 2)
  source.set(false)
  source.set(false)
  source.set(true)
  assert.equal(stops, 1)
  assert.equal(starts, 2, 'a failed stop must not create a second request')
  controller.dispose()
  assert.equal(stops, 2)
  assert.equal(failures, 2)
})

test('a project remains a source until shutdown settles, even after leaving the directory', async () => {
  const { controller, calls } = harness()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const tasks = new BackgroundTaskRegistry()
  const directory = new ProjectDirectory<DirectoryProject, DirectoryWorkspace>({
    onAdded(entry) {
      controller.watch(entry, { isActive: () => tasks.hasRunningWork(), subscribe: tasks.subscribe })
    },
    onClosed(entry) { controller.unwatch(entry) },
  })
  const entry = directory.add({ cwd: '/tmp/power-project', shutdown: () => gate }, { list: () => [], closeAll() {} })
  tasks.registerAgent({ sessionId: 'other-session', agentId: 'a', agentType: 'general', description: 'work' })
  const closing = directory.closeProject(entry, 'last-lane')
  assert.equal(directory.size, 0)
  assert.deepEqual(calls, ['prevent-app-suspension'])
  tasks.completeAgent('other-session', 'a', 'completed')
  assert.deepEqual(calls, ['prevent-app-suspension', 0])
  finish()
  await closing
  tasks.registerAgent({ sessionId: 'late', agentId: 'b', agentType: 'general', description: 'ignored' })
  assert.equal(calls.length, 2)
  controller.dispose()
})
