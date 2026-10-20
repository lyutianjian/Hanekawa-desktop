import test from 'node:test'
import assert from 'node:assert/strict'
import {
  _resetCachedShellForTests,
  describeShell,
  detectSleepPattern,
  SLEEP_BLOCK_THRESHOLD_SECONDS,
  resolveBashTimeoutMs,
  buildSubprocessEnv,
  SENSITIVE_ENV_VARS,
  SUBPROCESS_ENV_SCRUB_VAR,
  bashTool,
} from '../src/tools/BashTool/BashTool.js'
import { buildBashDescription } from '../src/tools/BashTool/prompt.js'

/**
 * The name the prompt's `# Environment` block gives the shell.
 *
 * It used to be derived there — `process.env.SHELL ?? (win32 ? 'powershell' :
 * 'bash')` — while the `Bash` tool itself prefers Git for Windows' `bash.exe`
 * and only falls back to PowerShell when no bash exists. The model was told
 * `powershell` and wrote `NUL`, `%VAR%` and backslash paths into a POSIX shell.
 *
 * `SHELL` is honoured on every platform (on Windows it is the first thing
 * `detectShell` consults after the explicit override), so these cases drive the
 * same detection the tool does without depending on the host's filesystem. The
 * platform is a parameter for the same reason: what the label has to say differs
 * between the two, and neither branch may be reachable only on one developer's
 * machine.
 */

function withShell(value: string, run: () => void): void {
  const before = process.env.SHELL
  process.env.SHELL = value
  _resetCachedShellForTests()
  try {
    run()
  } finally {
    if (before === undefined) delete process.env.SHELL
    else process.env.SHELL = before
    _resetCachedShellForTests()
  }
}

test('on Windows the shell is named as the POSIX shell it is', () => {
  // Git for Windows exports `SHELL=/bin/bash.exe`, so the path itself cannot say
  // 「Git Bash」 — the platform pairing is what carries it. Without this the
  // `Platform: win32` line right above reads as "use Windows syntax".
  withShell('/bin/bash.exe', () => {
    assert.equal(describeShell('win32'), 'bash (POSIX shell on Windows)')
  })
  withShell('C:/Program Files/Git/bin/bash.exe', () => {
    assert.equal(describeShell('win32'), 'bash (POSIX shell on Windows)')
  })
})

test('elsewhere the shell is named by its own binary, without path or extension', () => {
  withShell('/bin/bash', () => assert.equal(describeShell('linux'), 'bash'))
  withShell('/usr/bin/zsh', () => assert.match(describeShell('darwin'), /^zsh \(not bash/))
})

// The PowerShell fallback has no case here on purpose: `detectShell` ignores
// `SHELL=powershell` on Windows and goes looking for a bash anyway, so reaching
// that branch means a host with no bash installed — which is exactly the machine
// this suite does not get to choose. The label for it is a literal in one line.

test('the answer is cached, so the prompt pays one detection per process', () => {
  withShell('/bin/bash', () => {
    assert.equal(describeShell('linux'), 'bash')
    process.env.SHELL = '/usr/bin/zsh'
    assert.equal(describeShell('linux'), 'bash', 'the tool would spawn the shell it already resolved')
  })
})

// --- Bash tool description -------------------------------------------------
//
// The description is the only place the model learns three rules the tool
// enforces unconditionally: the working directory does not survive a call,
// stdin is closed, and a leading `sleep` past the threshold is refused. Each
// of those used to be discoverable only by failing.

function withEnv(name: string, value: string | undefined, run: () => void): void {
  const before = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    run()
  } finally {
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
}

test('the description quotes the timeouts the tool actually enforces', () => {
  withEnv('MYAGENT_BASH_DEFAULT_TIMEOUT_MS', undefined, () => {
    withEnv('BASH_DEFAULT_TIMEOUT_MS', undefined, () => {
      const description = buildBashDescription()
      assert.match(description, new RegExp(`default ${resolveBashTimeoutMs()}`))
      assert.match(description, /no maximum/)
    })
  })
})

test('an env override moves the quoted default with it', () => {
  withEnv('MYAGENT_BASH_DEFAULT_TIMEOUT_MS', '45000', () => {
    assert.match(buildBashDescription(), /default 45000/)
  })
})

test('the sleep rule quotes the threshold that rejects the command', () => {
  assert.match(
    buildBashDescription(),
    new RegExp(`sleep N\` with N >= ${SLEEP_BLOCK_THRESHOLD_SECONDS}`),
  )
  // The number in the prose has to be the one detectSleepPattern rules on.
  assert.equal(detectSleepPattern(`sleep ${SLEEP_BLOCK_THRESHOLD_SECONDS}`), SLEEP_BLOCK_THRESHOLD_SECONDS)
  assert.equal(detectSleepPattern(`sleep ${SLEEP_BLOCK_THRESHOLD_SECONDS - 1}`), null)
})

test('the description states the constraints the tool enforces silently', () => {
  const description = buildBashDescription()
  // cwd is re-read from ToolContext on every spawn, so `cd` cannot carry over.
  assert.match(description, /NOT carry over to the next Bash call/)
  // stdio is ['ignore', 'pipe', 'pipe'].
  assert.match(description, /stdin is closed/)
  assert.match(description, /--no-verify/)
  assert.match(description, /git add -A/)
})

test('the description is ASCII, like every other prompt string that reached the wire', () => {
  assert.doesNotMatch(buildBashDescription(), /[^\x00-\x7F]/)
})

test('building the description does not probe for a shell', () => {
  // buildBashDescription runs from getBuiltinTools(), which is called once per
  // runtime; describeShell()'s existsSync chain and spawnSync belong to the
  // first prompt build, not to that. Naming a shell here is how it creeps back.
  const description = buildBashDescription()
  assert.doesNotMatch(description, /powershell|bash\.exe|POSIX shell on Windows/i)
})

test('buildSubprocessEnv keeps credentials and injects git non-interactive editor by default', () => {
  const env = buildSubprocessEnv(undefined, {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
  })

  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test')
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'aws-secret')
  assert.equal(env.GIT_EDITOR, 'true')
})

test('buildSubprocessEnv scrubs sensitive keys and injects git non-interactive editor', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    [SUBPROCESS_ENV_SCRUB_VAR]: '1',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    OPENAI_API_KEY: 'sk-openai-test',
    CUSTOM_VAR: 'custom-value',
  }

  const env = buildSubprocessEnv({ MY_PORT: 8080, MY_FLAG: true }, baseEnv)

  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.CUSTOM_VAR, 'custom-value')
  assert.equal(env.GIT_EDITOR, 'true')
  assert.equal(env.GIT_SEQUENCE_EDITOR, 'true')
  assert.equal(env.MY_PORT, '8080')
  assert.equal(env.MY_FLAG, 'true')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('buildSubprocessEnv scrubs all defined sensitive keys', () => {
  const base: NodeJS.ProcessEnv = { [SUBPROCESS_ENV_SCRUB_VAR]: 'true' }
  for (const k of SENSITIVE_ENV_VARS) {
    base[k] = 'secret'
  }
  const scrubbed = buildSubprocessEnv(undefined, base)
  for (const k of SENSITIVE_ENV_VARS) {
    assert.equal(scrubbed[k], undefined, `expected ${k} to be scrubbed`)
  }
})

test('buildSubprocessEnv appends ipv4first to NODE_OPTIONS on win32 only', () => {
  assert.equal(buildSubprocessEnv(undefined, {}, 'win32').NODE_OPTIONS, '--dns-result-order=ipv4first')
  assert.equal(
    buildSubprocessEnv(undefined, { NODE_OPTIONS: '--max-old-space-size=4096' }, 'win32').NODE_OPTIONS,
    '--max-old-space-size=4096 --dns-result-order=ipv4first',
  )
  assert.equal(
    buildSubprocessEnv(undefined, { NODE_OPTIONS: '--dns-result-order=ipv4first' }, 'win32').NODE_OPTIONS,
    '--dns-result-order=ipv4first',
  )
  assert.equal(buildSubprocessEnv(undefined, {}, 'darwin').NODE_OPTIONS, undefined)
})

test('bashTool execution propagates custom env variables to subprocess', async () => {
  const context = {
    cwd: process.cwd(),
    sessionId: 'test-session',
    readFiles: new Set<string>(),
  }

  const result = await bashTool.execute({
    command: 'node -e "console.log(process.env.TEST_HANEKAWA_ENV)"',
    env: { TEST_HANEKAWA_ENV: 'hanekawa_works' },
  }, context)

  assert.equal(result.ok, true)
  assert.match(result.content, /hanekawa_works/)
})
