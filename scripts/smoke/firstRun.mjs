import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import * as app from './app.mjs'
import { evaluate, key, waitFor } from './cdp.mjs'
import { globalConfigPath } from './fixtures.mjs'
import { submitLine } from './probes.mjs'

const REPLY = 'First-run configuration works.'

/** A local OpenAI-compatible endpoint, with no external credentials or traffic. */
export async function startFirstRunFixture() {
  let requests = 0
  // Conversation turns only: a new session's first message also asks for a title, which carries no tools.
  let turns = 0
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url !== '/v1/chat/completions' || request.model !== 'first-run-model') {
        res.writeHead(400).end('Unexpected fixture request')
        return
      }
      requests += 1
      if (request.tools?.length) turns += 1
      const base = { id: `first-run-${requests}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model }
      const events = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
        .end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    get requests() { return requests },
    get turns() { return turns },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

const settingsOpen = (ctx) => evaluate(ctx.cdp, "document.body.classList.contains('settings-open')")

async function click(ctx, label) {
  await evaluate(ctx.cdp, `(() => {
    const button = [...document.querySelectorAll('#settings button')].find((node) => node.textContent.trim() === ${JSON.stringify(label)})
    if (!button) throw new Error('No settings button: ' + ${JSON.stringify(label)})
    button.click()
  })()`)
}

const dialogOpen = (ctx) => evaluate(ctx.cdp, "!!document.querySelector('#settings .settings-dialog-layer:not([hidden]) .settings-dialog')")

async function field(ctx, label, value) {
  await evaluate(ctx.cdp, `(() => {
    const input = [...document.querySelectorAll('#settings .settings-dialog input, #settings .settings-dialog select')]
      .find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!input) throw new Error('No settings field: ' + ${JSON.stringify(label)})
    input.value = ${JSON.stringify(value)}
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })()`)
}

async function runtime(ctx, lane) {
  const id = await app.post(ctx.app, lane, { type: 'hello' })
  await app.reply(ctx.app, id)
  return (await app.laneState(ctx.app)).runtime[lane]
}

async function send(ctx, lane, prompt) {
  const count = ctx.firstRunFixture.turns
  await evaluate(ctx.cdp, submitLine(prompt))
  await waitFor('a reply from the configured local provider', async () => {
    const state = await app.laneState(ctx.app)
    return ctx.firstRunFixture.turns > count && state.state[lane]?.streaming === false
      && await evaluate(ctx.cdp, `document.body.innerText.includes(${JSON.stringify(REPLY)})`)
  })
  ctx.eq('one turn reached the local provider', ctx.firstRunFixture.turns, count + 1)
}

async function firstRun(ctx) {
  await waitFor('first-run provider setup', async () => await settingsOpen(ctx)
    && await evaluate(ctx.cdp, "!!document.querySelector('#settings .settings-dialog .settings-provider-fields')"))
  const { lanes } = await app.shell(ctx.app, { type: 'panes' })
  const lane = lanes[0].lane
  ctx.eq('the app starts without creating a model config', existsSync(globalConfigPath(ctx.home)), false)
  ctx.eq('the session reports configuration is required', (await runtime(ctx, lane)).status, 'needs_configuration')
  ctx.eq('startup made no provider request', ctx.firstRunFixture.requests, 0)
  await ctx.shot('first-run-settings', 'the real desktop window opens directly into provider settings without a config file')

  await key(ctx.cdp, 'Escape')
  await waitFor('the untouched setup dialog to close', async () => !await dialogOpen(ctx))
  await key(ctx.cdp, 'Escape')
  await waitFor('settings to close', async () => !await settingsOpen(ctx))
  await runtime(ctx, lane)
  ctx.eq('another runtime snapshot does not reopen dismissed setup', await settingsOpen(ctx), false)
  await evaluate(ctx.cdp, submitLine('draft before setup'))
  await waitFor('the send action to open settings', () => settingsOpen(ctx))
  ctx.eq('the unconfigured send preserves the draft', await evaluate(ctx.cdp, "document.getElementById('input').value"), 'draft before setup')

  await click(ctx, '添加服务商')
  await field(ctx, '名称', 'first-run')
  await field(ctx, 'Base URL', ctx.firstRunFixture.baseUrl)
  await field(ctx, 'API Key', 'local-fixture-key')
  await click(ctx, '添加模型')
  await field(ctx, '模型 ID', 'first-run-model')
  await click(ctx, '保存')
  await waitFor('the first model to become ready', async () => (await runtime(ctx, lane)).status === 'ready')
  await waitFor('saving to close the provider dialog', async () => !await dialogOpen(ctx))
  const saved = JSON.parse(readFileSync(globalConfigPath(ctx.home), 'utf8'))
  ctx.eq('the provider is saved with the dialog protocol', saved.endpoints?.['first-run']?.provider, 'openai')
  ctx.eq('the first model is saved as default', saved.defaultModel, 'first-run-model')
  ctx.eq('saving keeps the settings screen open', await settingsOpen(ctx), true)
  await key(ctx.cdp, 'Escape')
  await waitFor('the configured conversation', async () => !await settingsOpen(ctx))
  ctx.eq('setup preserved the original draft throughout', await evaluate(ctx.cdp, "document.getElementById('input').value"), 'draft before setup')
  await send(ctx, lane, 'hello after first-time setup')
  await ctx.shot('first-run-response', 'the first configured model responds in the same app process')
}

async function restarted(ctx) {
  const { lanes } = await app.shell(ctx.app, { type: 'panes' })
  const lane = lanes[0].lane
  ctx.eq('the saved model is ready after restart', (await runtime(ctx, lane)).status, 'ready')
  ctx.eq('a configured startup does not open setup', await settingsOpen(ctx), false)
  await send(ctx, lane, 'hello after restart')
}

export const FIRST_RUN_STEPS = [
  { id: 'S0', item: 0, name: 'start without config, configure in the UI, and send a message', timeout: 45000, run: firstRun },
]

export const FIRST_RUN_RESTART_STEPS = [
  { id: 'S0R', item: 0, name: 'first-time configuration survives restart', timeout: 30000, run: restarted },
]
