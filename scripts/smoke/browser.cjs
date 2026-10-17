/**
 * The agent browser against real Chromium: the paths a stub DOM cannot prove.
 *
 * The Electron main process of `npm run smoke:browser`; `scripts/smoke-browser.mjs`
 * launches it with a private profile and removes that profile once Electron
 * has exited — Chromium keeps writing to it until then.
 *
 * It drives `DesktopBrowserHost` over that profile and a loopback server,
 * never the user's config, projects or browser partition data. What it checks
 * is behaviour only a real renderer has — beforeunload and user activation,
 * elementFromPoint, a native <select>, a key chord — and it exits non-zero if
 * any step fails, after printing each step.
 *
 * CommonJS on purpose: the built modules are ESM and are loaded with
 * `import()`, but an ESM *entry* point has been seen never to start at all in
 * a headless Linux container, while this one runs everywhere.
 */

const { app, BaseWindow, nativeImage } = require('electron')

// A window covered by another app stops producing frames on macOS, which
// stalls rAF, transitions and input under whatever the user is doing meanwhile.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const { createServer } = require('node:http')

const profile = process.argv.find((arg) => arg.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length)
if (!profile) throw new Error('The browser smoke requires --smoke-profile=<directory>')
app.setPath('userData', profile)
app.setPath('sessionData', profile)

const PAGES = {
  '/stay': `<!doctype html><title>Stay</title>
    <button id="arm" style="width:200px;height:40px">arm</button>
    <button id="disarm" style="width:200px;height:40px">disarm</button>
    <div id="cover-host" style="position:relative;width:200px;height:40px">
      <button id="covered" style="width:200px;height:40px">covered</button>
      <div id="banner" style="position:absolute;inset:0;background:#fc0" role="dialog" aria-label="Cookie banner"></div>
    </div>
    <select id="country"><option value="">Choose</option><option value="fr">France</option></select>
    <label id="terms-label"><input id="terms" type="checkbox" style="opacity:0;position:absolute"> Accept terms</label>
    <p id="prose">Order <b>confirmed</b> today</p>
    <script>
      document.getElementById('arm').onclick = () => {
        window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }
        document.body.insertAdjacentHTML('beforeend', '<p id="armed">armed</p>')
      }
      document.getElementById('disarm').onclick = () => { window.onbeforeunload = null }
      document.getElementById('country').onchange = (e) => { document.title = 'picked ' + e.target.value }
    </script>`,
  '/next': '<!doctype html><title>Next</title><p>next page</p>',
  // Bootstrap's reboot sets this; an animated scroll leaves a rect read right
  // after it at the old position.
  '/smooth': `<!doctype html><title>Smooth</title>
    <style>html { scroll-behavior: smooth }</style>
    <div style="height:3000px">top</div>
    <button id="far" style="width:200px;height:40px" onclick="document.title = 'clicked'">far</button>
    <div style="height:3000px">bottom</div>`,
  '/coords': `<!doctype html><title>Coords</title>
    <style>body { margin: 0 }</style>
    <button id="box" style="position:absolute;left:50px;top:60px;width:100px;height:30px">box</button>
    <canvas id="pad" style="position:absolute;left:0;top:200px" width="300" height="200"></canvas>
    <script>
      document.getElementById('pad').onclick = (e) => { document.title = 'pad ' + e.offsetX + ',' + e.offsetY }
    </script>`,
  '/phone': `<!doctype html><title>Phone</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <div style="height:1500px">top</div>
    <button id="tap" style="width:200px;height:40px" onclick="document.title = 'tapped'">tap</button>
    <div style="height:1500px">bottom</div>`,
  '/hover': `<!doctype html><title>Hover</title>
    <div id="trigger" style="width:200px;height:40px;background:#ddd">menu</div>
    <ul id="menu" style="display:none"><li>Profile</li></ul>
    <p id="ghost" hidden>ghost</p>
    <button id="later" disabled style="width:200px;height:40px">later</button>
    <input id="agree" type="checkbox">
    <p id="flicker" style="display:none">flicker</p>
    <script>
      const menu = document.getElementById('menu')
      document.getElementById('trigger').onmouseenter = () => { menu.style.display = 'block' }
      window.startTimers = () => {
        const flicker = document.getElementById('flicker').style
        setTimeout(() => { document.getElementById('later').disabled = false; document.getElementById('agree').checked = true }, 300)
        setTimeout(() => { flicker.display = 'block' }, 100)
        setTimeout(() => { flicker.display = 'none' }, 250)
        setTimeout(() => { flicker.display = 'block' }, 400)
      }
    </script>`,
  // The HTML is parsed at once; the image holds the load back.
  '/slow': `<!doctype html><title>Slow</title><p>parsed</p><img src="/slow.png">`,
  // A panel slides in while the data it shows is still on its way, next to a
  // spinner that never stops: settling has to wait for the first two only.
  '/settle': `<!doctype html><title>Settle</title>
    <style>
      #panel { width: 200px; height: 100px; background: #f00; transform: translateX(-300px); transition: transform 800ms linear }
      #panel.open { transform: none }
      .spin { width: 20px; height: 20px; background: #00f; animation: spin 1s linear infinite }
      @keyframes spin { to { transform: rotate(360deg) } }
    </style>
    <div class="spin"></div><div id="panel"></div>
    <script>
      requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('panel').classList.add('open')))
      fetch('/api/slow').then((r) => r.text()).then((t) => document.body.insertAdjacentHTML('beforeend', '<p id="data">' + t + '</p>'))
    </script>`,
  '/poll': `<!doctype html><title>Poll</title><p>live</p><script>fetch('/api/hang')</script>`,
  '/spa': `<!doctype html><title>Spa</title>
    <button id="push" style="width:200px;height:40px" onclick="history.pushState({}, '', '/spa/two')">push</button>`,
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname
  if (path === '/report.csv') {
    response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report 1.csv"' })
    response.end('a,b\n1,2\n')
    return
  }
  if (path === '/api/slow' || path === '/api/hang') {
    const timer = setTimeout(() => response.end('data'), path === '/api/slow' ? 900 : 8000)
    response.once('close', () => clearTimeout(timer))
    return
  }
  if (path === '/slow.png') {
    setTimeout(() => {
      response.writeHead(404)
      response.end()
    }, 1500)
    return
  }
  const page = PAGES[path]
  response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page ?? 'not found')
})
let origin = ''

let failed = false
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed = true
}

async function codeOf(promise) {
  try {
    await promise
    return 'none'
  } catch (error) {
    return error?.code ?? String(error)
  }
}

async function run() {
  const { BrowserTabHost } = await import('../../dist/desktop/browser/tabs.js')
  const { DesktopBrowserHost } = await import('../../dist/desktop/browser/host.js')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  await app.whenReady()
  const window = new BaseWindow({ width: 1000, height: 800, show: false })
  // Inactive, so the user's typing elsewhere never lands in the tab as a takeover.
  window.showInactive()
  const tabs = new BrowserTabHost()
  tabs.attachWindow(window)
  const host = new DesktopBrowserHost({ tabs, laneForSession: () => 'lane' })
  const caller = { sessionId: 'smoke', turnId: 'turn-1' }

  const tab = await host.createTab(caller, `${origin}/stay`)
  tabs.setBounds(tab.tabId, { x: 0, y: 0, width: 1000, height: 800 }, true)
  const loaded = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 10_000 })
  check('the first page loads', loaded.url === `${origin}/stay`, loaded.url)

  // C: a covered target is refused and named; an uncovered one is pressed.
  const covered = await host.click(caller, tab.tabId, { selector: '#covered' }).catch((error) => error)
  check(
    'a covered button is refused, naming the banner',
    covered?.code === 'ELEMENT_NOT_INTERACTABLE' && /Cookie banner/.test(covered.message),
    covered?.message,
  )
  // The click is also the user activation Chromium requires before it will
  // honour a beforeunload refusal.
  await host.click(caller, tab.tabId, { selector: '#arm' })
  // The click's handler runs a moment after the press is acknowledged.
  await host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 2000 })

  // B: the page refuses to be left.
  await host.navigate(caller, tab.tabId, `${origin}/next`)
  const refused = await codeOf(host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 }))
  check('a refused navigation ends the wait with NAVIGATION_FAILED', refused === 'NAVIGATION_FAILED', refused)
  const row = tabs.describe().find((entry) => entry.tabId === tab.tabId)
  check('the tab is no longer loading', row?.loading === false, JSON.stringify(row?.loading))
  check('the tab still shows the page that refused', row?.url === `${origin}/stay`, row?.url)
  const readable = await host.text(caller, tab.tabId, {}).catch((error) => error)
  check('the page it stayed on can still be read', typeof readable?.text === 'string', readable?.message)

  // A: text grouped by block, and wait_for on a split phrase.
  check('inline tags do not split a block', /(^|\n)text\tOrder confirmed today(\n|$)/.test(readable.text), readable.text)
  const waited = await codeOf(host.waitFor(caller, tab.tabId, { text: 'order confirmed', timeoutMs: 2000 }))
  check('wait_for finds a phrase split across inline tags', waited === 'none', waited)

  // E: a native select and a checkbox hidden behind its label.
  const picked = await host.selectOption(caller, tab.tabId, { selector: '#country', label: 'France' })
  check('select_option picks by label', /option 1 "France"/.test(picked.text), picked.text)
  // The title arrives through `page-title-updated`, a moment after the change.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const titled = (await host.listTabs(caller)).find((entry) => entry.tabId === tab.tabId)
  check('the page saw the change event', titled?.title === 'picked fr', titled?.title)
  const ticked = await host.setChecked(caller, tab.tabId, { selector: '#terms', checked: true })
  check('set_checked clicks a hidden checkbox through its label', /through its label/.test(ticked.text), ticked.text)
  const again = await host.setChecked(caller, tab.tabId, { selector: '#terms', checked: true })
  check('set_checked is idempotent', /already checked/.test(again.text), again.text)

  // D + F: a key chord, then a navigation the URL wait follows.
  const keyed = await host.pressKey(caller, tab.tabId, { keys: ['Shift', 'Tab'] })
  check('press_key sends a chord', /pressed Shift\+Tab/.test(keyed.text), keyed.text)
  await host.click(caller, tab.tabId, { selector: '#disarm' })
  await host.navigate(caller, tab.tabId, `${origin}/next`)
  const arrived = await codeOf(host.waitFor(caller, tab.tabId, { url: `${origin}/next`, timeoutMs: 5000 }))
  check('wait_for url follows a navigation once the page lets go', arrived === 'none', arrived)
  const next = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('the next page loads normally', next.url === `${origin}/next` && next.title === 'Next', next.url)

  // G: back and reload honour a refusal the same way navigate does.
  await host.navigate(caller, tab.tabId, `${origin}/stay`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  await host.click(caller, tab.tabId, { selector: '#arm' })
  await host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 2000 })
  for (const action of ['reload', 'back']) {
    await host.history(caller, tab.tabId, action)
    const code = await codeOf(host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 }))
    check(`a refused ${action} ends the wait with NAVIGATION_FAILED`, code === 'NAVIGATION_FAILED', code)
    const still = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 500 }))
    check(`the page that refused the ${action} is still there`, still === 'none', still)
  }
  await host.click(caller, tab.tabId, { selector: '#disarm' })
  await host.history(caller, tab.tabId, 'back')
  const back = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('back goes back once the page lets go', back.url === `${origin}/next`, back.url)
  await host.history(caller, tab.tabId, 'reload')
  const reloaded = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('a reload the page allows still loads', reloaded.url === `${origin}/next` && reloaded.title === 'Next', reloaded.url)

  // I: back between pushState entries keeps the document and still ends the wait.
  await host.navigate(caller, tab.tabId, `${origin}/spa`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  await host.click(caller, tab.tabId, { selector: '#push' })
  await host.waitFor(caller, tab.tabId, { url: `${origin}/spa/two`, timeoutMs: 2000 })
  await host.history(caller, tab.tabId, 'back')
  const inPage = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 3000 }).catch((error) => error)
  check('back across a pushState entry settles', inPage?.url === `${origin}/spa`, inPage?.url ?? inPage?.message)

  // H: a smooth-scrolling page does not leave an off-screen target off screen.
  await host.navigate(caller, tab.tabId, `${origin}/smooth`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  const far = await codeOf(host.click(caller, tab.tabId, { selector: '#far' }))
  check('an off-screen button on a smooth-scrolling page is clicked', far === 'none', far)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const clicked = (await host.listTabs(caller)).find((entry) => entry.tabId === tab.tabId)
  check('the click reached the button', clicked?.title === 'clicked', clicked?.title)
  const scrolled = await host.scroll(caller, tab.tabId, { direction: 'top' })
  check('scrolling to the top reports where it landed', /y=0 of /.test(scrolled.text), scrolled.text)

  // K: hover opens what only hover opens; the richer wait states read the real DOM.
  await host.navigate(caller, tab.tabId, `${origin}/hover`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  const hovered = await host.hover(caller, tab.tabId, { selector: '#trigger' }).catch((error) => error)
  check('hover reports the element it moved onto', /hovered over #trigger/.test(hovered?.text ?? ''), hovered?.text ?? hovered?.message)
  const menu = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#menu', timeoutMs: 1000 }))
  check('the hover opened the menu', menu === 'none', menu)
  const ghostVisible = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#ghost', timeoutMs: 200 }))
  const ghostAttached = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#ghost', state: 'attached', timeoutMs: 200 }))
  check('a hidden node is attached but not visible', ghostVisible === 'WAIT_TIMEOUT' && ghostAttached === 'none', `${ghostVisible}/${ghostAttached}`)
  await tabs.pageFor(tab.tabId).contents.executeJavaScript('startTimers()')
  const enabled = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#later', state: 'enabled', timeoutMs: 2000 }))
  check('a wait for enabled sees the button come alive', enabled === 'none', enabled)
  const checked = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#agree', state: 'checked', timeoutMs: 2000 }))
  check('a wait for checked sees the box ticked', checked === 'none', checked)
  const stableStart = Date.now()
  const stable = await host.waitFor(caller, tab.tabId, { selector: '#flicker', stableForMs: 300, timeoutMs: 3000 }).catch((error) => error)
  const stableMs = Date.now() - stableStart
  // The timers were started a little before this wait; it can only succeed
  // once the third timer fired and the element then held for 300ms.
  check('stableForMs outlasts a flicker', /held for/.test(stable?.text ?? '') && stableMs >= 300, `${stableMs}ms ${stable?.text ?? stable?.message}`)

  // M: positions in a snapshot, and a press at a bare point, share one CSS-pixel space.
  await host.navigate(caller, tab.tabId, `${origin}/coords`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  const bounded = await host.elements(caller, tab.tabId, { includeBounds: true })
  check('includeBounds reports the viewport box', /\tbox\t.*\t50,60,100,30$/m.test(bounded.text), bounded.text)
  const unbounded = await host.elements(caller, tab.tabId, {})
  check('bounds stay out unless asked for', !/bounds/.test(unbounded.text), unbounded.text)
  const pressed = await host.clickAt(caller, tab.tabId, { x: 30, y: 240 }).catch((error) => error)
  check('click_at names what it landed on', /landed on <canvas/.test(pressed?.text ?? ''), pressed?.text ?? pressed?.message)
  let pad
  for (const started = Date.now(); Date.now() - started < 2000; await new Promise((resolve) => setTimeout(resolve, 50))) {
    pad = (await host.listTabs(caller)).find((entry) => entry.tabId === tab.tabId)
    if (pad?.title !== 'Coords') break
  }
  check('click_at pressed at that CSS point', pad?.title === 'pad 30,40', pad?.title)
  const outside = await codeOf(host.clickAt(caller, tab.tabId, { x: 5000, y: 10 }))
  check('click_at refuses a point off the viewport', outside === 'INVALID_REQUEST', outside)

  const domStart = Date.now()
  await host.navigate(caller, tab.tabId, `${origin}/slow`)
  const dom = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000, until: 'domcontentloaded' })
  const domMs = Date.now() - domStart
  check('domcontentloaded does not wait for the slow image', dom.loading === true && domMs < 1200, `${domMs}ms loading=${dom.loading}`)
  const full = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  const fullMs = Date.now() - domStart
  check('load waits for it', full.loading === false && fullMs >= 1400, `${fullMs}ms`)
  // Back to the page the steps below click on.
  await host.navigate(caller, tab.tabId, `${origin}/smooth`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })

  // I: the debugger is attached for input, steps aside for DevTools, and the
  // automation refuses — retryably, naming DevTools — until it is closed.
  const contents = tabs.pageFor(tab.tabId).contents
  check('input attached the debugger', contents.debugger.isAttached())
  const opened = new Promise((resolve) => contents.once('devtools-opened', resolve))
  contents.openDevTools({ mode: 'detach' })
  await opened
  check('opening DevTools detaches the automation', !contents.debugger.isAttached())
  const devToolsRefusal = await host.click(caller, tab.tabId, { selector: '#far' }).catch((error) => error)
  check(
    'a click with DevTools open is refused, retryably, naming DevTools',
    devToolsRefusal?.code === 'PAGE_NOT_READY' && devToolsRefusal.retryable === true && /DevTools/.test(devToolsRefusal.message),
    devToolsRefusal?.message,
  )
  const closed = new Promise((resolve) => contents.once('devtools-closed', resolve))
  contents.closeDevTools()
  await closed
  const after = await codeOf(host.click(caller, tab.tabId, { selector: '#far' }))
  check('closing DevTools gives the automation its channel back', after === 'none' && contents.debugger.isAttached(), after)

  // J: who is driving. Real input from the person, through Chromium's own
  // input pipeline, read against the three states.
  const rowOf = () => tabs.describe().find((entry) => entry.tabId === tab.tabId)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
  check('mid-turn the tab is drawn as the agent\'s', rowOf()?.agentActive === true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: -120 })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' })
  await settle()
  check('a wheel and a lone modifier are not a takeover', rowOf()?.takenOver !== true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
  await settle()
  check('a press mid-turn takes the tab over', rowOf()?.takenOver === true && rowOf()?.agentActive !== true, JSON.stringify(rowOf()))
  const blocked = await codeOf(host.listTabs(caller))
  check('the taken-over session is refused', blocked === 'BROWSER_USER_TAKEOVER', blocked)

  host.turnEnded(caller.sessionId)
  check('the turn ending hands the tab back to idle', rowOf()?.takenOver !== true && rowOf()?.agentActive !== true, JSON.stringify(rowOf()))
  const late = await codeOf(host.listTabs(caller))
  check('a straggler from the ended turn is refused', late === 'OPERATION_ABORTED', late)
  const idleCaller = { sessionId: caller.sessionId, turnId: 'turn-2' }
  const snapshot = await host.elements(idleCaller, tab.tabId, {})
  const ref = /\b(e\d+)\b/.exec(snapshot.text)?.[1]
  host.turnEnded(caller.sessionId)
  contents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  await settle()
  check('a press between turns is not a takeover', rowOf()?.takenOver !== true, JSON.stringify(rowOf()))
  const nextTurn = { sessionId: caller.sessionId, turnId: 'turn-3' }
  const stale = await codeOf(host.click(nextTurn, tab.tabId, { ref }))
  check('a ref taken before the user touched the page misses', stale === 'STALE_ELEMENT', `${ref} → ${stale}`)
  check('the next turn draws the tab as the agent\'s again', rowOf()?.agentActive === true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  await settle()
  check('a keystroke mid-turn takes the tab over', rowOf()?.takenOver === true, JSON.stringify(rowOf()))

  // K: permissions and downloads, answered once for the whole partition.
  host.turnEnded(caller.sessionId)
  const downloader = { sessionId: caller.sessionId, turnId: 'turn-4' }
  const permission = await contents.executeJavaScript("navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state)")
  check('a permission check is answered denied', permission === 'denied', permission)
  const second = await host.createTab(downloader, `${origin}/next`)
  await host.waitForLoad(downloader, second.tabId, { timeoutMs: 10_000 })
  const cancelled = new Promise((resolve) => {
    tabs.pageFor(second.tabId).contents.session.once('will-download', (_event, item) => setImmediate(() => resolve(item.getState())))
  })
  await host.navigate(downloader, second.tabId, `${origin}/report.csv`)
  const state = await Promise.race([cancelled, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])
  check('a download is cancelled', state === 'cancelled', state)
  const listed = (await host.listTabs(downloader)).find((entry) => entry.tabId === second.tabId)
  check(
    'get_state names the blocked download on its tab only',
    JSON.stringify(listed?.blockedDownloads) === '["report 1.csv"]' &&
      (await host.listTabs(downloader)).find((entry) => entry.tabId === tab.tabId)?.blockedDownloads === undefined,
    JSON.stringify(listed),
  )
  check('the tab still shows the page it was on', listed?.url === `${origin}/next`, listed?.url)
  const settled = await host.waitForLoad(downloader, second.tabId, { timeoutMs: 3000 }).then(() => 'none', (error) => error?.code ?? String(error))
  check('wait_for_load after a download link does not hang', settled !== 'TIMEOUT', settled)

  // L: a tab the panel is not showing is parked, still painting, so a
  // screenshot is of the page as it is now rather than the last shown frame.
  host.turnEnded(caller.sessionId)
  const shooter = { sessionId: caller.sessionId, turnId: 'turn-5' }
  const centre = (shot) => {
    const image = nativeImage.createFromBuffer(shot.bytes)
    const { width, height } = image.getSize()
    const bitmap = image.crop({ x: Math.floor(width / 2), y: Math.floor(height / 2), width: 1, height: 1 }).toBitmap()
    return `${bitmap[2]},${bitmap[1]},${bitmap[0]}` // BGRA
  }
  // A capture off a hidden window goes through colour management and can land a step or two off.
  const near = (shot, rgb) => centre(shot).split(',').every((channel, index) => Math.abs(Number(channel) - rgb[index]) <= 8)
  const paint = async (colour) => {
    await contents.executeJavaScript(`document.documentElement.style.background = '${colour}'; document.body.style.visibility = 'hidden'`)
    await settle()
  }
  const visibleShot = await host.screenshot(shooter, tab.tabId)
  check('a shown tab is captured at its size', visibleShot.width === 1000 && visibleShot.height === 800, `${visibleShot.width}x${visibleShot.height}`)
  check('a screenshot reports its CSS viewport', visibleShot.cssWidth === 1000 && visibleShot.cssHeight === 800, `${visibleShot.cssWidth}x${visibleShot.cssHeight}`)
  tabs.setBounds(tab.tabId, { x: 0, y: 0, width: 1000, height: 800 }, false)
  await paint('rgb(255, 0, 0)')
  const red = await host.screenshot(shooter, tab.tabId).catch((error) => error)
  check('a hidden tab can still be captured', red?.bytes !== undefined, red?.message)
  check('the hidden capture keeps the last shown size', red?.width === 1000 && red?.height === 800, `${red?.width}x${red?.height}`)
  check('the hidden capture shows the page as it is now', red?.bytes !== undefined && near(red, [255, 0, 0]), red?.bytes && centre(red))
  await paint('rgb(0, 0, 255)')
  const blue = await host.screenshot(shooter, tab.tabId).catch((error) => error)
  check('a second hidden capture is a fresh frame', blue?.bytes !== undefined && near(blue, [0, 0, 255]), blue?.bytes && centre(blue))
  window.hide()
  await paint('rgb(0, 255, 0)')
  const green = await host.screenshot(shooter, tab.tabId).catch((error) => error)
  check('a capture works with the main window hidden', green?.bytes !== undefined && near(green, [0, 255, 0]), green?.bytes ? centre(green) : green?.message)
  window.showInactive()
  tabs.setBounds(tab.tabId, { x: 0, y: 0, width: 1000, height: 800 }, true)
  const shownAgain = await host.screenshot(shooter, tab.tabId).catch((error) => error)
  check('the tab captures again once shown', shownAgain?.bytes !== undefined && near(shownAgain, [0, 255, 0]), shownAgain?.bytes ? centre(shownAgain) : shownAgain?.message)

  // M: device emulation holds across a DevTools round trip and resets cleanly.
  host.turnEnded(caller.sessionId)
  const emulator = { sessionId: caller.sessionId, turnId: 'turn-6' }
  await host.navigate(emulator, tab.tabId, `${origin}/phone`)
  await host.waitForLoad(emulator, tab.tabId, { timeoutMs: 5000 })
  const probe = () => contents.executeJavaScript('({ w: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints })')
  const before = await probe()
  const emulated = await host.emulate(emulator, tab.tabId, { preset: 'iphone' }).catch((error) => error)
  const phone = await probe()
  check('emulate reports the viewport the page now sees', /innerWidth=390\b/.test(emulated?.text ?? ''), emulated?.text ?? emulated?.message)
  check('the iphone preset narrows the page and switches its user agent', phone.w === 390 && phone.dpr === 3 && /iPhone/.test(phone.ua) && phone.touch > 0, JSON.stringify(phone))
  const phoneShot = await host.screenshot(emulator, tab.tabId).catch((error) => error)
  check('a screenshot is of the emulated viewport', phoneShot?.width === 390 * 3 && phoneShot?.height === 844 * 3, `${phoneShot?.width}x${phoneShot?.height}`)
  const phoneClick = await host.click(emulator, tab.tabId, { selector: '#tap' }).catch((error) => error)
  await settle()
  check('a click lands under emulation', rowOf()?.title === 'tapped', `${phoneClick?.text ?? phoneClick?.message} title=${rowOf()?.title}`)
  const reopened = new Promise((resolve) => contents.once('devtools-opened', resolve))
  contents.openDevTools({ mode: 'detach' })
  await reopened
  const reclosed = new Promise((resolve) => contents.once('devtools-closed', resolve))
  contents.closeDevTools()
  await reclosed
  await host.elements(emulator, tab.tabId, {})
  const restored = await probe()
  check('the emulation comes back after DevTools took the debugger', restored.w === 390 && /iPhone/.test(restored.ua), JSON.stringify(restored))
  await host.navigate(emulator, tab.tabId, `${origin}/smooth`)
  await host.waitForLoad(emulator, tab.tabId, { timeoutMs: 5000 })
  const wide = await host.click(emulator, tab.tabId, { selector: '#far' }).catch((error) => error)
  await settle()
  check('a click lands on a zoomed-out page with no meta viewport', rowOf()?.title === 'clicked', `${wide?.text ?? wide?.message} title=${rowOf()?.title}`)
  const reset = await host.emulate(emulator, tab.tabId, { reset: true }).catch((error) => error)
  const plain = await probe()
  check('reset restores the real viewport and user agent', plain.w === before.w && plain.ua === before.ua && plain.dpr === before.dpr, `${reset?.text ?? reset?.message} ${JSON.stringify(plain)}`)

  // N: waiting for the page to settle, against real transitions and requests.
  host.turnEnded(caller.sessionId)
  const settler = { sessionId: caller.sessionId, turnId: 'turn-7' }
  const moving = () => contents.executeJavaScript(
    "({ data: !!document.getElementById('data'), transform: getComputedStyle(document.getElementById('panel')).transform })",
  )
  await host.navigate(settler, tab.tabId, `${origin}/settle`)
  const idle = await host.waitForLoad(settler, tab.tabId, { timeoutMs: 10_000, until: 'networkidle' }).catch((error) => error)
  const afterIdle = await moving()
  check('networkidle waits out the slow request and the slide, not the spinner', /^The page was settled after \d+ms/.test(idle?.settle ?? '') && afterIdle.data && afterIdle.transform === 'none', `${idle?.settle ?? idle?.message} ${JSON.stringify(afterIdle)}`)
  await host.navigate(settler, tab.tabId, `${origin}/settle`)
  await host.waitForLoad(settler, tab.tabId, { timeoutMs: 5000 })
  const early = await moving()
  const settledShot = await host.screenshot(settler, tab.tabId).catch((error) => error)
  const atShot = await moving()
  const shotWaitMs = Number(/after (\d+)ms/.exec(settledShot?.settle ?? '')?.[1] ?? 0)
  check('a screenshot right after load waits for the page to settle', !early.data && atShot.data && atShot.transform === 'none' && /^The page was settled/.test(settledShot?.settle ?? '') && shotWaitMs >= 500, `${settledShot?.settle ?? settledShot?.message} before=${JSON.stringify(early)} at=${JSON.stringify(atShot)}`)
  const rushed = await host.screenshot(settler, tab.tabId, { settle: false }).catch((error) => error)
  check('settle: false captures without waiting or reporting', rushed?.bytes !== undefined && rushed.settle === undefined, rushed?.message)
  await host.navigate(settler, tab.tabId, `${origin}/poll`)
  await host.waitForLoad(settler, tab.tabId, { timeoutMs: 5000 })
  const started = Date.now()
  const polled = await host.screenshot(settler, tab.tabId).catch((error) => error)
  const pollMs = Date.now() - started
  check('a long poll stops holding the page up and is named', /^The page was settled.*long-running request not waited for: 127\.0\.0\.1:\d+\/api\/hang/.test(polled?.settle ?? '') && pollMs < 3000, `${polled?.settle ?? polled?.message} in ${pollMs}ms`)

  host.dispose()
  tabs.dispose()
  window.destroy()
}

void (async () => {
  try {
    await run()
  } catch (error) {
    check('the run completed', false, error?.stack ?? String(error))
  } finally {
    server.close()
    app.exit(failed ? 1 : 0)
  }
})()
