#!/usr/bin/env node
/**
 * Real Electron motion acceptance (M21–M22).
 *
 * npm run build:desktop
 * node scripts/motion-desktop.mjs --scale=1 --out=.smoke/motion-100
 * node scripts/motion-desktop.mjs --scale=1.25 --out=.smoke/motion-125
 *
 * Uses a loopback-only SSE fixture and the real agent/tool/permission path.
 * Raw DevTools traces (including screenshots), every delivered rAF sample and
 * projected CSS events are retained only with --out or --keep. No production hooks or
 * animation framework. By default device scale is Chromium's override. The
 * Windows wrapper can instead change and restore native DPI with --dpi=native.
 * Like smoke:desktop, this needs a display and runs outside npm test.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import * as app from './smoke/app.mjs'
import * as fixtures from './smoke/fixtures.mjs'
import * as probes from './smoke/probes.mjs'
import { evaluate, key, mouseClick, shot, sleep, waitFor } from './smoke/cdp.mjs'
import { startMotionFixture } from './smoke/motionFixture.mjs'
import { installMotionProbe, summarizeMotion } from './smoke/motionProbe.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  if (arg === '--keep') return ['keep', true]
  const match = /^--(scale|out|port|theme|dpi)=(.+)$/.exec(arg)
  if (!match) throw new Error('unknown argument: ' + arg)
  return [match[1], match[2]]
}))
const scale = Number(args.scale ?? 1)
if (![1, 1.25].includes(scale)) throw new Error('--scale must be 1 or 1.25')
const dpi = args.dpi ?? 'chromium'
if (!['chromium', 'native'].includes(dpi)) throw new Error('--dpi must be chromium or native')
const theme = args.theme ?? 'dark'
if (!['dark', 'light'].includes(theme)) throw new Error('--theme must be dark or light')
const tripwires = fixtures.captureTripwires(repoRoot)
const environment = fixtures.createSmokeEnvironment({ keep: Boolean(args.keep), copyConfig: false })
const runDir = environment.root
const out = resolve(args.out ?? join(runDir, 'output'))
const saveOutput = Boolean(args.keep) || args.out !== undefined
const port = Number(args.port ?? 9237)
const pidFile = join(out, 'motion-electron.pid')
mkdirSync(out, { recursive: true })
const report = { generatedAt: new Date().toISOString(), scale, dpi, theme, environment: {}, checks: [], scenes: {}, cleanup: [] }
let fixture
let handle
let recording
let tracing
let screencast
const read = (source) => evaluate(handle.cdp, source)
const mark = (label) => read('window.__motion.mark(' + JSON.stringify(label) + ')')
const watch = (name, selector, scope = 'pane') =>
  read('window.__motion.watch(' + [name, selector, scope].map(JSON.stringify).join(',') + ')')
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
}
const visiblePane = "([...document.querySelector('#transcript-area').children].find(n => !n.hidden))"
async function click(selector) {
  const point = await read(probes.centreOf(selector))
  await mouseClick(handle.cdp, point.x, point.y)
}
async function present(selector) {
  return waitFor(selector, () => read("(() => { const n = document.querySelector(" + JSON.stringify(selector)
    + "); return !!n && !n.hidden && !n.inert && n.getClientRects().length > 0 })()"))
}
async function begin(scene) {
  console.log('SCENE ' + scene)
  await read('window.__motion.start(' + JSON.stringify(scene) + ')')
  recording = scene
  const done = new Promise((resolve) => {
    const remove = handle.cdp.on('Tracing.tracingComplete', (event) => { remove(); resolve(event.stream) })
  })
  await handle.cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing'
      + (scene === 'stream' ? '' : ',disabled-by-default-devtools.screenshot'),
    options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream',
  })
  tracing = { scene, done }
  if (scene === 'stream') {
    // The trace filmstrip stops after 450 screenshots. An acknowledged CDP
    // screencast keeps the entire long turn, with its original wall timestamps.
    const frames = []
    const remove = handle.cdp.on('Page.screencastFrame', (frame) => {
      frames.push({ timestamp: frame.metadata.timestamp, jpeg: frame.data })
      void handle.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    })
    screencast = { frames, remove }
    await handle.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 })
  }
}
async function finish() {
  const scene = recording
  if (!scene) return
  const record = await read('window.__motion.stop()')
  recording = undefined
  writeFileSync(join(out, scene + '-frames.json.gz'), gzipSync(JSON.stringify(record)))
  const summaries = summarizeMotion(record)
  report.scenes[scene] = { summaries }
  if (screencast) {
    await handle.cdp.send('Page.stopScreencast')
    screencast.remove()
    writeFileSync(join(out, scene + '-capture.json.gz'), gzipSync(JSON.stringify({ timeOrigin: record.timeOrigin, frames: screencast.frames })))
    report.scenes[scene].capture = { frames: screencast.frames.length,
      firstTime: screencast.frames[0]?.timestamp, lastTime: screencast.frames.at(-1)?.timestamp }
    screencast = undefined
  }
  if (tracing) {
    await handle.cdp.send('Tracing.end')
    const stream = await tracing.done
    const chunks = []
    for (;;) {
      const result = await handle.cdp.send('IO.read', { handle: stream, size: 1024 * 1024 })
      chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'))
      if (result.eof) break
    }
    await handle.cdp.send('IO.close', { handle: stream })
    const data = Buffer.concat(chunks)
    writeFileSync(join(out, scene + '-trace.json.gz'), gzipSync(data))
    const trace = JSON.parse(data.toString('utf8'))
    const pictures = trace.traceEvents.filter((event) => event.name === 'Screenshot' && event.args?.snapshot)
    const folder = join(out, scene + '-screens')
    mkdirSync(folder, { recursive: true })
    for (const [i, event] of pictures.entries()) {
      writeFileSync(join(folder, String(i).padStart(4, '0') + '.jpg'), Buffer.from(event.args.snapshot, 'base64'))
    }
    report.scenes[scene].trace = {
      events: trace.traceEvents.length, screenshots: pictures.length,
      screenshotTimesUs: pictures.map((event) => event.ts),
      frameEvents: trace.traceEvents.filter((event) => /DrawFrame|BeginFrame/.test(event.name)).length,
    }
    tracing = undefined
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  return record
}

function assertBuild() {
  for (const path of ['dist/desktop/main.js', 'dist/desktop/preload.js', 'dist/desktop/renderer/app.js']) {
    if (!existsSync(join(repoRoot, path))) throw new Error('run npm run build:desktop first')
  }
  if (readFileSync(join(repoRoot, 'src/desktop/renderer/styles.css'), 'utf8')
    !== readFileSync(join(repoRoot, 'dist/desktop/renderer/styles.css'), 'utf8')) throw new Error('stale CSS: run npm run build:desktop')
  const built = Math.min(...['main.js', 'preload.js', 'renderer/app.js'].map((file) => statSync(join(repoRoot, 'dist/desktop', file)).mtimeMs))
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(path) && statSync(path).mtimeMs > built) throw new Error('stale build: ' + path)
    }
  }
  walk(join(repoRoot, 'src'))
}

async function chooseTheme(label) {
  await key(handle.cdp, 'Ctrl+,')
  await present('#settings')
  await read(probes.clickSettingsNav('外观'))
  await read(probes.clickSettingsPill())
  await present('#settings .settings-menu')
  await read(probes.clickSettingsMenuItem(label))
  await key(handle.cdp, 'Escape')
  await sleep(400)
}

async function streamingScene(project, lane) {
  await begin('stream')
  for (const [name, selector] of Object.entries({
    group: '.activity-group', groupHead: '.group-head', groupBody: '.group-steps',
    liveBead: '.group-head .waiting-bead', thought: '.thinking-step-head', rule: '.thinking-step-head .step-rule',
    thoughtBody: '.step.thinking .step-body',
  })) await watch(name, selector)
  fixture.arm()
  const turn = await app.post(handle, lane, { type: 'submit', input: 'Desktop motion: continuous thought, short tools, Markdown and reading position.' })
  await present('.thinking-step-head')
  await read("document.querySelector('.thinking-step-head').focus()")
  await mark('thought-noop')
  await sleep(1200)
  check('thought keeps focus through incremental and unchanged paints',
    await read("document.activeElement === window.__motion.node('thought')"))
  await click('.canvas-menu-trigger')
  await present('.canvas-menu')
  await watch('menu', '.canvas-menu', 'document')
  await watch('menuItem', '.canvas-menu .canvas-menu-item', 'document')
  await key(handle.cdp, 'ArrowDown')
  const menuFocus = await read("window.__motion.hold('menuFocus', document.activeElement)")
  await mark('stream-menu')
  await sleep(1200)
  check('stream menu keeps its focused item', await read("document.activeElement === window.__motion.node('menuFocus')"), menuFocus)
  await key(handle.cdp, 'Escape')
  await present('.task-panel')
  await watch('taskPanel', '.task-panel', 'document')
  await watch('progress', '.task-progress-fill', 'document')
  await click('.task-panel-head')
  await present('.task-row')
  await watch('taskRow', '.task-row', 'document')
  await watch('taskBead', '.task-row .task-bead', 'document')
  await present('.task-row.in_progress')
  await mark('task-unchanged')
  await sleep(1100)
  await mark('tools-to-markdown')
  await present('.md .katex')
  await watch('paragraph', '.md p')
  await watch('code', '.md pre')
  await watch('math', '.md .katex')
  await mark('markdown-growth')
  await click('.scroll-bottom')
  await sleep(1500)
  const point = await read(probes.centreOf('.pane:not([hidden]) .transcript'))
  await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -480 })
  await sleep(250)
  const anchor = await read("(() => { const p = " + visiblePane + "; const s = p.querySelector('.transcript').getBoundingClientRect(); const n = [...p.querySelectorAll('.step-head,.md p')].find(n => { const r = n.getBoundingClientRect(); return r.top >= s.top + 8 && r.bottom < s.bottom }); if (!n) return null; window.__motion.hold('readingAnchor',n); return n.getBoundingClientRect().top })()")
  await read("(() => { const n = window.__motion.node('paragraph'); const r = document.createRange(); r.selectNodeContents(n); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()")
  await mark('upward-reading')
  await app.reply(handle, turn, { timeout: 60000 })
  await sleep(650)
  check('upward reading anchor survives the rest of the stream and turn end',
    anchor !== null && Math.abs((await read("window.__motion.node('readingAnchor')?.getBoundingClientRect().top")) - anchor) <= 1, { before: anchor, after: await read("window.__motion.box('readingAnchor')?.y") })
  check('stable Markdown selection survives', await read("getSelection().toString().startsWith('稳定首段')"))
  for (const name of ['paragraph', 'code', 'math']) {
    check(name + ' stays attached', await read("window.__motion.node(" + JSON.stringify(name) + ")?.isConnected"))
  }
  await shot(handle.cdp, join(out, 'stream-reading.png'))
  const record = await finish()
  const live = record.frames.filter((frame) => frame.streaming && frame.nodes.group?.id)
  check('live group never collapses in tool gaps', live.length > 0 && live.every((frame) => !frame.nodes.group.cls.includes('collapsed')))
  check('no blank content sample after the group appears', live.length > 0 && live.every((frame) => frame.visibleText > 0), { samples: live.length })
  for (const [label, names] of [['thought-noop', ['thought', 'rule', 'thoughtBody']], ['stream-menu', ['menu', 'menuFocus']], ['task-unchanged', ['taskPanel', 'progress', 'taskRow', 'taskBead']], ['markdown-growth', ['paragraph', 'code', 'math']]]) {
    for (const name of names) {
      const target = report.scenes.stream.summaries[label]?.targets[name]
      check(label + ' stable ' + name, target?.identities.length === 1 && target.detaches === 0, target && { identities: target.identities.length, detaches: target.detaches })
    }
  }
  const progress = report.scenes.stream.summaries['task-unchanged'].targets.progress
  check('unchanged task progress has no width movement', progress.widthRange <= 1, { widthRange: progress.widthRange })
  const groupBead = live.find((frame) => frame.nodes.liveBead?.id)?.nodes.liveBead.id
  check('group breath starts once for the whole live turn',
    record.events.filter((event) => event.id === groupBead && event.type === 'animationstart' && event.name === 'breathe').length === 1)
  await read('getSelection().removeAllRanges()')
}

async function historyScene(project, lane) {
  const original = (await app.shell(handle, { type: 'panes' })).lanes.find((item) => item.lane === lane)
  await app.shell(handle, { type: 'open-session', projectRoot: project.root })
  await app.post(handle, lane, { type: 'close-pane', paneId: original.paneId })
  await waitFor('the old lane to release', async () => (await app.shell(handle, { type: 'panes' })).lanes.every((item) => item.lane !== lane))
  await begin('history')
  const reopened = await app.shell(handle, { type: 'open-session', projectRoot: project.root, sessionId: original.sessionId })
  await present('.activity-group')
  await sleep(450)
  const record = await finish()
  check('reloaded history does not replay completion', !record.events.some((event) => event.type === 'animationstart' && event.name === 'bead-pop'))
  check('reloaded history starts in its final folded state', await read("document.querySelector('.pane:not([hidden]) .group-head').getAttribute('aria-expanded') === 'false'"))
  return reopened.lane
}

async function disclosureScene() {
  // Explicitly locate a completed group's head before measuring the interaction.
  await read("document.querySelector('.group-head').scrollIntoView({block:'center',behavior:'instant'})")
  await sleep(500)
  if (await read("document.querySelector('.group-head').getAttribute('aria-expanded') !== 'true'")) {
    await click('.group-head'); await sleep(450)
  }
  if (await read("document.querySelector('.thinking-step-head').getAttribute('aria-expanded') !== 'true'")) {
    await click('.thinking-step-head'); await sleep(450)
  }
  await begin('disclosure')
  await watch('head', '.thinking-step-head')
  await watch('body', '.step.thinking .step-body')
  await watch('group', '.activity-group')
  await mark('detail-close')
  await click('.thinking-step-head')
  await sleep(90)
  await mark('detail-reverse')
  await click('.thinking-step-head')
  await sleep(450)
  await mark('detail-close-settle')
  await click('.thinking-step-head')
  await sleep(450)
  check('closing detail removes its body after settlement', await read("!window.__motion.node('head').parentElement.querySelector('.step-body')"))
  await mark('detail-open')
  await click('.thinking-step-head')
  await sleep(450)
  await watch('bodyReopened', '.step.thinking .step-body')
  await shot(handle.cdp, join(out, 'detail-open.png'))
  const record = await finish()
  const varied = record.frames.filter((frame) => frame.nodes.body?.visible).map((frame) => frame.nodes.body.h)
  check('detail has intermediate measured heights', new Set(varied).size >= 6, { distinctHeights: new Set(varied).size })
  check('completed details do not replay completion', !record.events.some((event) => event.type === 'animationstart' && event.name === 'bead-pop'))
}

async function layoutScene() {
  await begin('layout')
  await watch('sidebar', '#sidebar', 'document')
  await watch('column', '.transcript-column')
  await watch('menu', '.canvas-menu', 'document')
  await mark('sidebar-close')
  await key(handle.cdp, 'Ctrl+b')
  await sleep(100)
  await mark('sidebar-reverse')
  await key(handle.cdp, 'Ctrl+b')
  await sleep(550)
  await mark('menu-open')
  await click('.canvas-menu-trigger')
  await sleep(95)
  await mark('menu-close')
  await click('.canvas-menu-trigger')
  await sleep(60)
  await mark('menu-reverse')
  await click('.canvas-menu-trigger')
  await sleep(420)
  check('reversed menu is interactive', await read("!document.querySelector('.canvas-menu').inert && !document.querySelector('.canvas-menu').hidden"))
  await key(handle.cdp, 'Escape')
  await sleep(350)
  check('menu settles closed', await read("document.querySelector('.canvas-menu').hidden"))
  await shot(handle.cdp, join(out, 'layout.png'))
  const record = await finish()
  const widths = record.frames.map((frame) => frame.nodes.sidebar?.w).filter((value) => value !== undefined)
  check('sidebar has intermediate measured widths', new Set(widths).size >= 6, { distinctWidths: new Set(widths).size })
}

async function permissionScene(project, lane) {
  await begin('permission')
  await watch('composer', '#composer', 'document')
  await watch('input', '#input', 'document')
  await watch('card', '#composer-request', 'document')
  for (const action of ['allow', 'deny']) {
    await mark('permission-' + action + '-enter')
    const id = await app.post(handle, lane, { type: 'run-tool', name: 'Write',
      input: { filePath: join(project.root, action + '.txt'), content: 'motion handoff\n' } })
    await present('#composer-request')
    await sleep(550)
    check('pending request blocks the shell new-session action', await read("[...document.querySelectorAll('.sidebar-nav-item')].find(n => n.textContent.includes('新建会话')).disabled"))
    check('composer has a height transition', await read("getComputedStyle(document.querySelector('#composer')).transitionProperty.includes('height')"))
    await mark('permission-' + action + '-exit')
    const view = await read(probes.permissionRequest())
    const button = view.actions.find((button) => action === 'allow' ? button.primary : button.label.startsWith('拒绝'))
    if (!button) throw new Error('permission action not found: ' + JSON.stringify(view.actions))
    await mouseClick(handle.cdp, button.x, button.y)
    check('shell unblocks before the permission visual exits', await read("![...document.querySelectorAll('.sidebar-nav-item')].find(n => n.textContent.includes('新建会话')).disabled && !document.querySelector('#composer-request').hidden"))
    check('input is ready while permission card exits', await read("document.activeElement === document.querySelector('#input') && document.querySelector('#composer-request').inert && !document.querySelector('#composer-request').hidden"))
    await handle.cdp.send('Input.insertText', { text: 'draft during exit' })
    check('typing survives permission exit', await read("document.querySelector('#input').value.includes('draft during exit')"))
    const replyDuringExit = await waitFor('permission result', () => app.hasReply(handle, id), { interval: 10 })
    check('permission bridge returns before visual exit settles', replyDuringExit && await read("!document.querySelector('#composer-request').hidden"))
    await app.reply(handle, id)
    await sleep(500)
    await read("document.querySelector('#input').value = ''; document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}))")
  }
  await finish()
  for (const label of ['permission-allow-enter', 'permission-allow-exit', 'permission-deny-enter', 'permission-deny-exit']) {
    const target = report.scenes.permission.summaries[label]?.targets.composer
    check(label + ' interpolates its height', target?.distinctHeights >= 6, { heights: target?.distinctHeights })
  }
}

async function questionScene(lane) {
  await begin('question')
  await watch('composer', '#composer', 'document')
  await watch('card', '#composer-request', 'document')
  await mark('question-enter')
  const id = await app.post(handle, lane, { type: 'run-tool', name: 'AskUserQuestion', input: {
    questions: ['第一项：选择验收记录？', '第二项：确认继续验收？'].map((question) => ({
      question, header: '动效验收', options: [
        { label: '继续', description: '记录状态交接' }, { label: '查看', description: '查看已有记录' },
      ],
    })),
  } })
  await present('#composer-request')
  await sleep(450)
  await mark('question-content')
  await key(handle.cdp, '1')
  await key(handle.cdp, 'Enter')
  await sleep(150)
  check('question content updates in the same dock', await read("window.__motion.node('card') === document.querySelector('#composer-request') && document.querySelector('#composer-request').textContent.includes('第二项')"))
  await mark('question-exit')
  await key(handle.cdp, '1')
  await key(handle.cdp, 'Enter')
  check('question settles business and focus before exit', await read("document.querySelector('#composer-request').inert && !document.querySelector('#composer-request').hidden && document.activeElement === document.querySelector('#input')"))
  await key(handle.cdp, 'y')
  check('question exit does not intercept typing', await read("document.querySelector('#input').value === 'y'"))
  await waitFor('question tool reply', () => app.hasReply(handle, id), { interval: 10 })
  check('question bridge reply precedes visual removal', await read("!document.querySelector('#composer-request').hidden"))
  await app.reply(handle, id)
  await sleep(350)
  await read("document.querySelector('#input').value = ''; document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}))")
  await finish()
  check('question card interpolates the composer height', report.scenes.question.summaries['question-enter']?.targets.composer?.distinctHeights >= 6, {
    heights: report.scenes.question.summaries['question-enter']?.targets.composer?.distinctHeights,
  })
}

async function settingsScene() {
  await begin('settings')
  await watch('settings', '#settings', 'document')
  await mark('settings-enter')
  await key(handle.cdp, 'Ctrl+,')
  await present('#settings')
  await sleep(450)
  await read(probes.clickSettingsNav('通用'))
  await present('.settings-toggle')
  await watch('toggle', '.settings-toggle', 'document')
  await watch('knob', '.settings-toggle-knob', 'document')
  await mark('toggle-save')
  const before = await read("document.querySelector('.settings-toggle').getAttribute('aria-checked')")
  await click('.settings-toggle')
  await sleep(650)
  check('setting toggle commits on its original node', await read("window.__motion.node('toggle') === document.querySelector('.settings-toggle') && window.__motion.node('knob') === document.querySelector('.settings-toggle-knob') && !document.querySelector('.settings-toggle').disabled"))
  check('setting value changed', before !== await read("document.querySelector('.settings-toggle').getAttribute('aria-checked')"))
  await shot(handle.cdp, join(out, 'settings.png'))
  await mark('settings-exit')
  await key(handle.cdp, 'Escape')
  await sleep(350)
  const record = await finish()
  const transforms = record.frames.filter((frame) => frame.label === 'toggle-save').map((frame) => frame.nodes.knob?.transform)
  check('settings knob traverses intermediate positions', new Set(transforms).size >= 5, { positions: new Set(transforms).size })
}

async function reducedScene() {
  await begin('reduced')
  await watch('sidebar', '#sidebar', 'document')
  await watch('menu', '.canvas-menu', 'document')
  await click('.canvas-menu-trigger')
  await sleep(70)
  await mark('reduce-mid-entrance')
  await handle.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(60)
  check('reduced preference reaches JavaScript', await read("document.documentElement.dataset.reducedMotion === 'true'"))
  check('reduced entrance settles without displacement', await read("document.querySelector('.canvas-menu').classList.contains('presence-open') && getComputedStyle(document.querySelector('.canvas-menu')).transform === 'none'"))
  await key(handle.cdp, 'Escape')
  await sleep(30)
  check('reduced exit settles and unmounts', await read("document.querySelector('.canvas-menu').hidden"))
  await key(handle.cdp, 'Ctrl+b')
  await sleep(30)
  await key(handle.cdp, 'Ctrl+b')
  await sleep(30)
  await handle.cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await sleep(100)
  const record = await finish()
  check('restoring motion does not replay the task panel', !record.events.some((event) => event.type === 'animationstart' && event.name === 'rise-in' && event.target.includes('task-panel')))
}

try {
  assertBuild()
  app.preflightProcesses({ port, pidFile, killStale: false })
  console.log('scratch: ' + runDir)
  const project = fixtures.makeProject(runDir, 'motion-acceptance', environment.home)
  fixtures.seedLocalSettings(project, { permissions: { ask: ['Write'], allow: ['Read', 'Glob', 'TaskCreate', 'TaskUpdate'] } })
  fixture = await startMotionFixture(project)
  writeFileSync(fixtures.globalConfigPath(environment.home), JSON.stringify(fixture.config, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(join(environment.home, '.myagent', 'projects.json'), JSON.stringify({ projects: [project.root] }) + '\n')
  handle = app.launch({ repoRoot, cwd: project.root, port, out, tag: 'motion', pidFile, environment,
    switches: dpi === 'native' ? [] : ['--force-device-scale-factor=' + scale] })
  await app.attach(handle)
  const initialDevicePixelRatio = await read('devicePixelRatio')
  if (dpi === 'native' && initialDevicePixelRatio !== scale) throw new Error('Native DPI does not match --scale: ' + initialDevicePixelRatio)
  // Zero disables scale emulation; only the CSS viewport size is normalized.
  await handle.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: dpi === 'native' ? 0 : scale, mobile: false })
  report.environment = await read('(' + installMotionProbe.toString() + ')()')
  report.environment.initialDevicePixelRatio = initialDevicePixelRatio
  check('renderer uses the requested device scale', report.environment.devicePixelRatio === scale)
  report.environment.browser = await handle.cdp.send('Browser.getVersion')
  console.log('ENV ' + JSON.stringify(report.environment))
  await chooseTheme(theme === 'dark' ? '深色' : '浅色')
  await read("[...document.querySelectorAll('.project-heading')].filter(n => n.textContent.includes('最近') && n.getAttribute('aria-expanded') === 'true').forEach(n => n.click())")
  const { lanes } = await app.shell(handle, { type: 'panes' })
  let lane = lanes[0].lane
  await streamingScene(project, lane)
  lane = await historyScene(project, lane)
  await disclosureScene()
  await layoutScene()
  await permissionScene(project, lane)
  await questionScene(lane)
  await settingsScene()
  await reducedScene()
  await shot(handle.cdp, join(out, theme + '-' + scale + '.png'))
  await chooseTheme(theme === 'dark' ? '浅色' : '深色')
  await shot(handle.cdp, join(out, (theme === 'dark' ? 'light' : 'dark') + '-' + scale + '.png'))
  check('renderer has no exceptions', handle.exceptions.length === 0, handle.exceptions)
} catch (error) {
  report.fatal = error.stack ?? String(error)
  console.error(report.fatal)
  if (handle?.cdp) {
    try { await shot(handle.cdp, join(out, 'failure.png')); await finish() } catch {}
  }
} finally {
  // All teardown paths report independently; cleanup cannot be skipped by
  // a failed screenshot, closed transport or a locked scratch file.
  if (handle) {
    try {
      report.cleanup.push(await app.quitGracefully(handle))
    } catch (error) { report.cleanup.push('ERROR quitting: ' + String(error)) }
    try {
      const note = await app.ensureStopped(handle)
      if (note) report.cleanup.push(note)
    } catch (error) { report.cleanup.push('ERROR stopping: ' + String(error)) }
  }
  if (fixture) {
    report.fixtureEvents = fixture.events
    try { await fixture.close() } catch (error) { report.cleanup.push('ERROR fixture: ' + String(error)) }
  }
  try { fixtures.assertTripwires(repoRoot, tripwires) } catch (error) { report.cleanup.push('ERROR tripwires: ' + String(error)) }
  const failure = environment.cleanup()
  if (failure) report.cleanup.push('ERROR scratch: ' + failure)
  report.cleanup.push(`scratch: ${runDir} (${args.keep ? 'kept' : failure ? 'NOT REMOVED' : 'removed'})`)
  if (saveOutput) writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(saveOutput ? 'REPORT ' + join(out, 'report.json') : existsSync(out) ? 'Output remains at ' + out : 'Temporary output removed; use --out=<dir> to retain the report and recordings.')
for (const note of report.cleanup) console.log('teardown: ' + note)
process.exitCode = report.fatal || report.checks.some((check) => !check.ok) || report.cleanup.some((note) => note.includes('ERROR')) ? 1 : 0
