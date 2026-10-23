import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DesktopPlatform } from '../src/desktop/types.js'
import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'

/**
 * Does the shipped renderer actually come up?
 *
 * `app.ts` is the wiring layer and has no unit tests: the views are pinned on
 * one side (`dom/`) and the decisions on the other (`model/`), but the file that
 * puts them together is covered by nothing but the desktop smoke — which needs a
 * display and did not run. Stage 6 is what that cost: a `shellClient` call added
 * inside `applyResolvedTheme`, whose only call site at the time ran at module top
 * level *above* `const shellClient`, threw before a single view was constructed.
 * (In the source that is a temporal-dead-zone `ReferenceError`; in the shipped
 * bundle esbuild has hoisted the binding, so the same fault surfaces as
 * `TypeError: Cannot read properties of undefined (reading 'setWindowTheme')` —
 * worth knowing when reading a real DevTools console.) The window opened with
 * nothing in it but the static HTML, and four typecheck programs and 2377 tests
 * stayed green —
 * `const` hoisting makes the forward reference legal to `tsc` (`TS2448` only
 * fires within one block), and no test ever evaluated this module.
 *
 * `test/desktopBuild.test.ts` came one line away from catching it: it imports the
 * same bundle, but with no DOM at all, so it dies on `window.hanekawa` — three
 * statements before the bug. This file gives the bundle just enough of a browser
 * to get past that: the ids `index.html` declares, a bridge that answers `panes`
 * with an empty topology, and nothing else. What it then asserts is the thing a
 * user sees first — that the title bar and the sidebar have something in them.
 *
 * It is deliberately *not* in `desktopBuild.test.ts`, which would have saved a
 * build: this file imports `helpers/domStub.ts`, whose one `HTMLElement` cast
 * needs the DOM lib, and `tsc` follows imports past `exclude` — so any test
 * touching the stub belongs to the fourth program (`tsconfig.domtest.json`).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const buildRoot = mkdtempSync(join(tmpdir(), 'hanekawa-renderer-boot-'))
const bundle = join(buildRoot, 'app.js')

before(async () => {
  writeFileSync(join(buildRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  // The same invocation `package.json`'s `build:desktop` ships, so what boots
  // here is what boots in Electron rather than a tsx-transpiled approximation.
  // The installed bin/esbuild may be a native executable on macOS/Linux.
  // The JS API selects the correct executable without treating it as JS.
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ['src/desktop/renderer/app.ts'],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'chrome120',
    mainFields: [],
    alias: { 'node:crypto': './src/desktop/renderer/runtime/nodeCryptoShim.ts' },
    outfile: bundle,
  })
})

after(() => {
  rmSync(buildRoot, { recursive: true, force: true })
})

/** Every `id` the page declares, so `required()` finds what it asks for. */
function declaredIds(): string[] {
  const html = readFileSync(join(repoRoot, 'src', 'desktop', 'renderer', 'index.html'), 'utf8')
  return [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))]
}

/**
 * The page, as the renderer will find it: one detached node per declared id.
 *
 * Built from `index.html` rather than from a list here, which makes this the
 * guard for the other half of `required()` — an id the renderer asks for and the
 * page never declares fails with the error `dom.ts` writes for exactly that.
 */
function mountPage(dom: DomStub): Map<string, unknown> {
  const nodes = new Map<string, unknown>()
  for (const id of declaredIds()) {
    const node = dom.createContainer()
    // `setAttribute('id', …)` is what registers a node with the stub's
    // `getElementById`; assigning a property would not.
    ;(node as unknown as { setAttribute(name: string, value: string): void }).setAttribute('id', id)
    nodes.set(id, node)
  }
  return nodes
}

interface FakeHost {
  /** Commands the renderer posted on the shell lane, in order. */
  readonly shellCommands: Array<{ type: string }>
  install(): void
  uninstall(): void
}

/**
 * A host that answers exactly one command.
 *
 * `panes` has to be answered or startup never gets past its `await` — the first
 * paint hangs behind it. Everything else is left unanswered on purpose: every
 * other call at boot is fire-and-forget, `ShellClient` has no request timeout,
 * and an unanswered promise keeps nothing alive, so silence here is both honest
 * and inert.
 */
function fakeHost(platform: DesktopPlatform = 'win32'): FakeHost {
  const shellCommands: Array<{ type: string }> = []
  let deliver: ((message: unknown) => void) | undefined

  const bridge = {
    platform,
    send(message: unknown): void {
      const frame = message as { kind?: string; lane?: string; body?: { type?: string; id?: string } }
      if (frame.kind !== 'data' || frame.lane !== '__shell' || !frame.body) return
      shellCommands.push({ type: frame.body.type ?? '' })
      if (frame.body.type !== 'panes') return
      deliver?.({
        kind: 'data',
        lane: '__shell',
        body: { type: 'reply', id: frame.body.id, result: { lanes: [] } },
      })
    },
    onMessage(handler: (message: unknown) => void): () => void {
      deliver = handler
      return () => {
        deliver = undefined
      }
    },
    close(): void {
      deliver = undefined
    },
  }

  const fakeWindow = {
    hanekawa: bridge,
    navigator: {},
    innerWidth: 1080,
    // No preference either way: `resolveTheme` then decides from the stored
    // preference, which is `null` here, i.e. "follow system".
    matchMedia: window.matchMedia.bind(window),
    addEventListener() {},
    removeEventListener() {},
  }

  const storage = { getItem: () => null, setItem() {} }
  // The page runs a minute ticker for its relative times, stopped only by
  // `pagehide`. Clear whatever interval the bundle started instead of firing
  // that: a live interval keeps the test process running forever.
  const realSetInterval = globalThis.setInterval
  const intervals: Array<ReturnType<typeof setInterval>> = []

  return {
    shellCommands,
    install(): void {
      Reflect.set(globalThis, 'window', fakeWindow)
      Reflect.set(globalThis, 'localStorage', storage)
      Reflect.set(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
        const handle = realSetInterval(...args)
        intervals.push(handle)
        return handle
      })
    },
    uninstall(): void {
      Reflect.deleteProperty(globalThis, 'window')
      Reflect.deleteProperty(globalThis, 'localStorage')
      Reflect.set(globalThis, 'setInterval', realSetInterval)
      for (const handle of intervals.splice(0)) clearInterval(handle)
    },
  }
}

test('the shipped renderer boots and paints its window chrome', async (t) => {
  const dom = installDomStub()
  const host = fakeHost()
  host.install()
  const page = mountPage(dom)
  t.after(() => {
    host.uninstall()
    dom.uninstall()
  })

  // A fresh URL per evaluation: `desktopBuild.test.ts` imports this same file
  // and it *fails* there by design, and Node's ESM loader caches a failed
  // evaluation — the same specifier would hand back that error rather than run.
  await import(`${pathToFileURL(bundle).href}?boot`)
  // Startup is a round trip; let its microtasks finish before looking.
  await tick()

  // The regression this file exists for: everything below module top level —
  // every view, the bootstrap IIFE — is downstream of the module evaluating to
  // completion, so "it painted" is the only assertion that covers all of it.
  assert.ok(
    dom.inspect(page.get('titlebar')).children.length > 0,
    'the title bar is empty: the renderer never got as far as its first render',
  )
  assert.ok(
    dom.inspect(page.get('sidebar')).children.length > 0,
    'the sidebar is empty: the renderer never got as far as its first render',
  )

  // `app.ts` catches a failed bootstrap and writes it into `<body>`, so a throw
  // in there would otherwise pass for a healthy boot.
  assert.equal(dom.inspect(dom.body()).text, '', 'startup wrote a failure into <body>')

  // The theme is resolved in JS and read back by the stylesheet off `<html>`.
  const { theme } = (dom.documentElement() as { dataset: Record<string, string | undefined> }).dataset
  assert.ok(theme === 'dark' || theme === 'light', `expected a resolved theme, got ${String(theme)}`)

  // The real app subscription, using M01's controllable media-query stub.
  const root = dom.documentElement() as HTMLElement
  assert.equal(root.dataset.reducedMotion, 'false')
  dom.setMedia('(prefers-reduced-motion: reduce)', true)
  assert.equal(root.dataset.reducedMotion, 'true')
  dom.setMedia('(prefers-reduced-motion: reduce)', false)
  assert.equal(root.dataset.reducedMotion, 'false')
  dom.setHidden(true)
  assert.equal(root.dataset.windowHidden, 'true')
  dom.setHidden(false)
  assert.equal(root.dataset.windowHidden, 'false')
})

test('the macOS renderer starts with traffic-light space and Command tooltips', async (t) => {
  const dom = installDomStub()
  const host = fakeHost('darwin')
  host.install()
  const page = mountPage(dom)
  t.after(() => {
    host.uninstall()
    dom.uninstall()
  })
  await import(`${pathToFileURL(bundle).href}?boot-mac`)
  await tick()

  const root = dom.documentElement() as HTMLElement
  const properties = (root.style as unknown as { properties: Map<string, string> }).properties
  assert.equal(root.dataset.platform, 'darwin')
  assert.equal(properties.get('--titlebar-inset-left'), '80px')
  assert.equal(properties.get('--titlebar-inset-right'), '0px')
  const rail = findByClass(dom.inspect(page.get('titlebar')), 'titlebar-rail')
  assert.equal((rail?.node as HTMLElement).title, '收起侧栏（⌘B）')
  const settings = findByClass(dom.inspect(page.get('sidebar')), 'sidebar-settings')
  assert.equal((settings?.node as HTMLElement).title, '打开设置（⌘,）')
  assert.equal(dom.inspect(dom.body()).text, '', 'startup reported an error')
})

/** The first descendant carrying `className`, depth-first, or `undefined`. */
function findByClass(view: StubView, className: string): StubView | undefined {
  if (view.classes.includes(className)) return view
  for (const child of view.children) {
    const hit = findByClass(child, className)
    if (hit) return hit
  }
  return undefined
}

test('a new session leaves the settings screen instead of opening behind it', async (t) => {
  // The screen covers the whole window now, so this is not a nicety: with the
  // sidebar hidden there is no second place for the new conversation to appear,
  // and a click that only mutated host state would look like nothing happened.
  // Asserted through the shipped bundle because the wiring is `app.ts`'s alone —
  // `runSidebarIntent` and `renderSettings` are not reachable from any unit test.
  const dom = installDomStub()
  const host = fakeHost()
  host.install()
  const page = mountPage(dom)
  t.after(() => {
    host.uninstall()
    dom.uninstall()
  })

  await import(`${pathToFileURL(bundle).href}?settings`)
  await tick()

  const bodyClasses = () => dom.inspect(dom.body()).classes
  const sidebar = () => dom.inspect(page.get('sidebar'))
  const settingsOpen = () => !dom.inspect(page.get('settings')).hidden

  const gear = findByClass(sidebar(), 'sidebar-settings')
  assert.ok(gear, 'the sidebar footer must offer 设置')
  dom.click(gear.node)
  assert.equal(settingsOpen(), true, 'the gear must open the screen')
  assert.ok(bodyClasses().includes('settings-open'), '<body> is what hides the sidebar')

  // The first nav item is 新建会话 (`dom/sidebarView.ts` builds it first).
  const create = findByClass(sidebar(), 'sidebar-nav-item')
  assert.ok(create, 'the sidebar must offer 新建会话')
  dom.click(create.node)
  assert.equal(dom.inspect(page.get('settings')).attributes.get('inert'), '', 'creating a session immediately leaves settings noninteractive')
  dom.dispatch(page.get('settings'), 'transitionend', { propertyName: 'opacity' })
  assert.equal(settingsOpen(), false, 'the settings pixels leave after the exit settles')
  assert.ok(!bodyClasses().includes('settings-open'), 'the sidebar must come back with it')
})

test('booting pulls the topology and repaints the native title-bar overlay', async () => {
  // The two commands startup owes the host. `set-window-theme` is the one 6a
  // added: the three window buttons are painted by the OS out of reach of the
  // stylesheet, so a theme that never reaches main is a mismatched strip.
  const dom = installDomStub()
  const host = fakeHost()
  host.install()
  mountPage(dom)
  try {
    await import(`${pathToFileURL(bundle).href}?commands`)
    await tick()
    const types = host.shellCommands.map((command) => command.type)
    assert.ok(types.includes('panes'), `startup must pull the topology, saw ${types.join(', ')}`)
    assert.ok(
      types.includes('set-window-theme'),
      `startup must repaint the overlay, saw ${types.join(', ')}`,
    )
  } finally {
    host.uninstall()
    dom.uninstall()
  }
})
