# Hanekawa / MyAgent

Hanekawa, also called MyAgent, is a lightweight self-hosted programming agent with an Electron desktop app. It supports Anthropic and OpenAI-compatible APIs, session persistence, automatic context compaction, skills, permission-gated tools, image input, project coordination, and a built-in browser.

## Requirements

- Node.js 22 or newer
- Bun or npm
- An Anthropic or OpenAI-compatible API key to use a model; startup and configuration do not require one

## Install

```bash
bun install
```

Or:

```bash
npm install
```

## Configure

Start the desktop (`npm run build:desktop`, then `npm run start:desktop`). When no usable
default model is configured, the app opens its existing configuration screen
automatically: **模型与服务商**. You can close it to view sessions and history, and
reopen it from the **配置模型** control.

Add an endpoint with its provider, API key and optional Base URL, then add a model
using that endpoint and the provider's model ID. Saving the endpoint before adding
a model is supported. The first resolvable model you save becomes the default when
no default has been selected. Configuration takes effect without restarting; all
open projects receive global provider changes, with running turns finishing before
their runtime is replaced. Removing the last model returns the app to configuration
state. An attempted message before setup keeps its draft and attachments.

The app creates and saves `~/.myagent/config.json` for all projects. A missing model,
broken model reference or incomplete provider configuration leaves setup available.
Startup does not test network connectivity or remote authentication; request errors
are reported when a model is used.

You can also edit `~/.myagent/config.json` manually:

```json
{
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "sk-ant-..."
    },
    "openai-compatible": {
      "provider": "openai",
      "model": "deepseek-chat",
      "apiKey": "sk-...",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  },
  "defaultModel": "claude",
  "fallbackModel": "openai-compatible",
  "agent": {
    "system": "You are Hanekawa, a CLI programming assistant."
  }
}
```

`config.json` is global only. Legacy project `.myagent/config.json` files are migrated
into the global configuration and archived on first load. Settings such as permissions
and MCP trust continue to support project-specific layers.

### Project instructions

Hanekawa reads the project's own instructions into every prompt. Starting at the working directory and
walking up to the filesystem root, it collects:

- `CLAUDE.md`, or `AGENTS.md` if there is no `CLAUDE.md`
- every `*.md` under `.myagent/rules/`

then, from the working directory only, `CLAUDE.local.md` — or `AGENTS.local.md` if that one is absent.
Keep the local file out of version control for personal notes.

Each directory contributes **one** of the two instruction files, not both: repositories that keep
`AGENTS.md` and `CLAUDE.md` in sync would otherwise send the same guide twice in every request. Files
are read outermost first, so the nearest one wins, and the local file is read last of all.

The set is read once when a project opens and captured when a session's runtime is built, the same way
hooks are. Editing one of these files mid-session takes effect on the next settings reload — saving
anything on the desktop settings screen does one, and it rebuilds the runtime when the instructions
changed.

### Auto memory

The model can keep notes that outlive a session: your corrections and preferences, project background the
code does not show, and where external material lives. They are plain Markdown files in
`~/.myagent/projects/<key>/memory/` (one directory per working directory; the home directory gets its own),
each with a small frontmatter, plus an index `MEMORY.md` with one line per note. Open or edit them with any
editor, or ask the model to forget one.

- **Loading**: the index is read when a session's runtime is first built and goes into the system prompt;
  `/clear` and `/resume` read it again, a model switch or settings reload does not. A note written mid-session
  shows up in the next session. The index is cut at 200 lines or 25,000 bytes.
- **Approval**: in the main conversation, reading, writing and deleting a `*.md` file directly inside the memory
  directory never prompts, in any permission mode (plan mode included). Deny rules still apply, and ask rules
  still ask (except in `bypass`). The directory also counts as workspace, so a read-only shell command on it
  (`ls`, `cat`, `grep`) runs without asking; a shell command that writes or deletes there asks as usual.
- **Switch**: `"autoMemory": false` in settings turns it off for sessions opened afterwards: no prompt section,
  no approval exemption, no directory created. Existing notes are kept.
- **Not covered**: subagents neither see nor use memory, and memory files are not part of `/rewind`. Removing a
  project on the desktop deletes its memory with the rest of its data.

### Routing

`routing` sends a particular role to a particular model. Every value is a key from `models`, or
`"inherit"` to follow the main loop's model:

```json
{
  "routing": {
    "main": "inherit",
    "plan": "claude",
    "compact": "openai-compatible",
    "subagent": {
      "general": "inherit",
      "explore": "openai-compatible"
    }
  }
}
```

A `subagent` type with no entry of its own falls back to `subagent.general`, then to `inherit`.
Everything defaults to `inherit`, so a one-model setup needs no `routing` block at all.

> **Breaking change.** The `fast` / `balanced` / `powerful` tiers and the `profiles` layer that mapped
> them to models are gone; `routing` names model keys directly. A config still using them starts
> normally and prints a warning: tier-valued `routing` entries are read as `"inherit"`, and a
> `defaultModel` naming a tier falls back to the first model that resolves. Two behaviors went away
> with the tiers — plan mode no longer upgrades the model automatically, and compaction no longer
> downgrades it. Set `routing.plan` / `routing.compact` (or the standalone `compactModel`) to get
> either back.

A project's `.myagent/` holds only shared configuration you put there (settings, skills, agents, rules,
MCP). Sessions and other runtime state (spilled tool output, image attachments, plan files) and your
personal per-project settings (`settings.local.json`, `agents.local/`) are kept under
`~/.myagent/projects/<key>/`, where `<key>` is derived from the project's path, so nothing the app
writes on its own ever appears in the project. Renaming or moving a project gives it a new key and
an empty history; the old history stays under the old key. A project whose sessions or local settings still sit in its
own `.myagent/` (from earlier versions) has them moved on the next open: each file is copied and
verified before the original is removed, an emptied `.myagent/` is deleted, and anything that could not
be moved stays where it was with a startup warning.

### Thinking

Extended thinking is on by default: requests carry the provider's adaptive thinking config, and
`/effort <low|medium|high|xhigh|max>` tunes how much of it the model spends.

Not every model takes every level, and some endpoints reject an unsupported one outright rather than
rounding it down. `supportedEfforts` names the levels a model accepts — 思考等级 in the desktop
settings screen's model form, where it is a checklist. Absent means all five. A level outside the set
is shown as unavailable in the picker and moves to the nearest supported one below it:

```json
"models": {
  "big": { "provider": "anthropic", "model": "claude-opus-5", "supportedEfforts": ["low", "high"] }
}
```

`/thinking off` turns it off — requests then carry no `thinking` parameter at all — and `/thinking on`
turns it back on. Either form writes `thinking` to the project's `settings.local.json` and applies
to the session you are in; the desktop settings screen has the same switch under 通用 › 扩展思考. The
switch is read when a runtime is built, so it also covers subagents.

```json
{ "thinking": false }
```

### The desktop settings screen

The desktop app has a settings screen (`⚙ 设置` at the bottom of the sidebar, or ⌘, on macOS / Ctrl+, elsewhere) covering the
same configuration. Which file each page writes is not uniform, and the screen names the file it is
about to change:

| Page | Writes |
|---|---|
| Models and providers, subagent routing, context management | `~/.myagent/config.json` |
| Permission rules, startup permission mode, extended thinking, prompt-cache TTL, MCP trust | `~/.myagent/projects/<key>/settings.local.json` (per project, never inside it) |

Two consequences worth knowing:

- Permission rules **concatenate** across settings layers and MCP trust is **unioned**, so the screen can
  only edit the entries in `settings.local.json`. Rules inherited from `~/.myagent/settings.json` or the
  project's `settings.json` are listed as read-only, and a trust granted in one of those files cannot be
  revoked from the screen — remove it there.
- The six context-management numbers are read once when a project starts, so changing them takes effect
  after a restart. Everything else on the screen applies to open sessions immediately.

### Project coordination (desktop only)

Choose 「项目调度」 in a project's menu to open that project's coordinator, one long-lived session per
project. The coordinator is read-only plus dispatch (its permission mode is locked to `readonly`): it can
read and search code and start, message, stop and resolve **threads**, which are ordinary sessions that do
the work. Threads default to `auto` permission mode and cannot start threads themselves. A thread that
writes code gets its own git worktree under `~/.myagent-worktrees/<key>/<threadId>` on branch
`hanekawa/<slug>-<threadId>`; read-only threads share the project directory.

- **Sidebar**: the 「项目调度」 section at the top lists each project's coordinator with running / needs-you
  counts, and its threads indented below with status chips.
- **Thread view**: the header shows 「← 协调 · 线程名 [状态] [停止]」. The right panel's 「线程」 tab lists
  threads with stop / resolve, 「全部停止」, and folded counts of quiet and resolved ones.
- **Reports**: when a thread's turn ends, a short sanitized note (data, not instructions) appears in the
  coordinator transcript as a card. The coordinator wakes once all dispatched threads have stopped; a
  thread's `AskCoordinator` question wakes it immediately. At most 10 automatic wakes happen after you last
  spoke in the coordinator. Permission prompts are never forwarded to the model: a thread waiting on
  one shows as 「需要你」 with a desktop notification.
- **Merging**: above the input, a thread shows 「项目名 分支名 +N −M [合并] ×」; the coordinator shows
  「N 个线程分支待合并」, expandable. The app runs `git merge` itself. It refuses while the main working tree
  has uncommitted changes. On conflict it aborts the merge and shows 「有冲突 [让线程解决]」, which asks the
  thread to update its branch. A successful merge removes the worktree and branch and resolves the thread.
- **Long sessions**: the coordinator receives a board snapshot of thread states and uses a coordinator
  compaction prompt; after compaction the latest board is restored. It is compacted early when idle past
  the cache TTL with over 40% context used, and if compaction keeps failing a new coordinator session is
  seeded from the summary and board.
- **Settings**: the 「项目调度」 card in the agent category sets the coordinator and thread model and effort,
  and 安静天数 (default 3) and 自动结案天数 (default 7) after which idle threads are marked quiet or resolved;
  0 disables either. Threads interrupted by a restart are marked, not resumed.

### Desktop shortcuts on macOS

The desktop title bar reserves space for the native traffic lights, including after resizing,
zooming, and entering or leaving fullscreen. Drag its blank area to move the window.

| Action | macOS | Windows / Linux |
|---|---|---|
| Toggle sidebar | ⌘B | Ctrl+B |
| New session | ⌘T | Ctrl+T |
| Close current session | ⌘W | Ctrl+W |
| Switch open session | ⌘1–9 | Ctrl+1–9 |
| Open project | ⇧⌘O | Ctrl+Shift+O |
| Settings | ⌘, | Ctrl+, |

⌘W closes the active session; the red traffic light closes the window. Native editing,
⌘Q to quit, and Control+⌘F for fullscreen remain available through the macOS menus.

### Image input

A model receives images only when you turn that on for it: `supportsImageInput: true` on the model in
`config.json`, or the 「支持图像输入」 switch in a model form — the desktop settings screen
has it, when creating a model and when editing one. It is off by default and
never inferred from the model name or endpoint; two models behind one endpoint can differ. Only the
`anthropic` and `openai` providers carry images in this version — with any other provider the switch
has no effect, and image sends are blocked with the same reason as a text-only model. The switch is a
claim, not a probe: an endpoint that rejects image parts answers with its own error, which Hanekawa
shows together with what to do next.

PNG, JPEG, GIF, and WebP are accepted. The real format is sniffed from the bytes, so a wrong extension
does not matter; EXIF orientation is applied; animated GIF and WebP contribute their first frame; SVG
keeps its text semantics. BMP, HEIC, TIFF, and AVIF are refused with a prompt to convert them to PNG
or JPEG first. The `Read` tool sends image files to the model under the same rules, captioned with the
original and sent dimensions.

Ways to attach, with at most 10 images per input (explicit attachments and `@` images together); a
message can be images alone:

- **Desktop** — paste an image into the composer, drag and drop files, or pick 「选择图片」 from the `+`
  menu. A thumbnail appears per image; clicking it opens a preview, and 「打开原图」 opens the stored
  copy in your viewer.

Every image is stored first and sent as a normalized copy: EXIF-rotated, colors normalized, metadata
stripped, scaled down to a 2,000 px long edge (never enlarged), then compressed — PNG first to keep
text and transparency readable, JPEG for large screenshots — to at most 3.75 MB per image. Raw input
over 20 MB or 40 megapixels is rejected, as is an image that still exceeds the budget at the lowest
quality; the error says which and suggests cropping.

While the active model cannot see images, sending **new** images is blocked before the turn starts —
the draft is kept, and the reason points at `/model`. Images already in the conversation become text
placeholders carrying the file path, with one notice per change rather than one per step. The
originals stay in the session, and switching back to an image-capable model sends them again.
Compaction always summarizes images as text — the compact model needs no image support — and keeps
the latest user message's images; compacted images can be re-read from the cached path. A request
carries at most 100 images, dropping the oldest historical ones first; the current input's images are
never dropped silently.

Attachments live under `~/.myagent/projects/<key>/attachments/<session-id>/`. Importing copies the image — your source file is never modified or
deleted, not by sending, by removing a draft attachment, nor by deleting the session. Deleting a
session deletes its stored attachments; closing a pane or restarting keeps them; files nothing
references any more are cleaned up once a 24-hour retention window has passed.

### The built-in browser (desktop only)

The desktop app carries a real browser the agent drives and you watch. Open it from 「视图 →
显示浏览器」; it takes a panel on the right of the window, with its own tab strip, address bar, and a
resizable divider. Tabs belong to the lane they were opened in — switching projects switches the tabs
with them — and closing a lane closes its pages.

The agent reaches the same tabs through the `Browser` tool: it opens and navigates tabs, reads a page
as a table of operable elements or as plain text, takes screenshots, and clicks, types and scrolls.
Unlike `WebFetch`, JavaScript runs, logins persist between calls, and what the model reads is the
rendered page rather than its HTML source. Navigation asks your permission per host, the way
`WebFetch` does.

Pages load in their own persistent session partition, so their cookies are separate from the app's,
and nothing of Hanekawa is reachable from a page: no preload script, no Node integration, sandboxed
and context-isolated, with automation confined to an isolated world of its own. Password, one-time-code
and card fields are never projected to the model — their text and value come back empty — and what the
agent types into one is never echoed back into the transcript.

You can take a tab back at any time: press 「接管」 in the address bar, or simply type, click or scroll
in the page. The agent's next browser call fails with an instruction to stop and ask you what you
want, and it stays blocked for the rest of that turn — your next message hands control back. There is
no button for handing it back, because sending the agent a message is that button.

## Start

Build the desktop app, then launch it:

```bash
npm run build:desktop
npm run start:desktop
```

`build:desktop` compiles the main process with `tsc`, bundles the preload and renderer with
esbuild, and copies the renderer assets into `dist/`. `start:desktop` runs Electron against
that `dist/`, so rebuild after changing sources.

### Desktop motion and reading

The desktop uses gentle, visible motion for menus, details, the sidebar and permission
cards. Opening and closing are continuous, and reversing an action continues from its
current position. Streaming text stays readable while new content arrives. Approving or
rejecting a request takes effect immediately and returns focus to the composer while the
card finishes closing.

Thought and tool details that opened during a turn stay open across tool handoffs. When
the whole turn finishes, automatically opened details can fold together. Manual choices,
keyboard focus, text selections and reading further up the conversation are protected.
When you read earlier messages, new output does not pull you back to the bottom.
**Return to latest** moves there immediately.
Restoring a conversation shows its saved content without replaying tool completion effects.

The desktop follows the system's **Reduce motion** preference, including changes made while
it is open. Movement, scaling and looping effects stop, pending visual transitions settle,
and state labels and controls remain available. Navigation and request replies stay immediate.

## Test

Run all tests:

```bash
bun run test
```

Run type checking:

```bash
bun run typecheck
```

Run one or more test files:

```bash
npm test -- test/config.test.ts
npm test -- test/config.test.ts test/cacheBreakDetection.test.ts
```

`npm test` gives its child processes a disposable home and temp directory, then removes
them after success, failure or interruption. Use this entry point for focused tests too.

### Desktop smoke run (the real app)

`npm test` never launches Electron: it is offline and hermetic, and worth keeping that
way. The desktop shell is therefore verified by a separate driver that launches the real
app, drives it over the Chrome DevTools Protocol, and checks what only a running window
can show — that a background session keeps streaming, that a parked permission prompt
survives a session switch, that deleting a session removes every artifact, that the
settings screen persists across a restart.

```bash
npm run build:desktop      # it refuses to run against a stale dist/
npm run smoke:desktop
npm run smoke:desktop -- --first-run
```

It needs a display, so it is a local check. The default run uses your configured
provider. `--first-run` starts with no configuration file and uses a local mock
OpenAI-compatible endpoint: it verifies opening setup, preserving a draft, saving an
endpoint and model through the UI, sending a message, and using the saved model after
a restart. This mode needs no real credentials and makes no external model requests.

- **It does not touch your data.** The app uses scratch projects, a disposable home
  and a private Electron profile. A `0600` copy of `~/.myagent/config.json` supplies the
  providers; test models, project registrations, sessions and file history stay in the
  disposable home. Assertions confirm that the repository's sessions and your real
  config, settings and project registry were left untouched.
- **It spends nothing by default.** One item — a live turn continuing in the background —
  needs a real model turn, and it only runs with `--paid-turn`. That turn is capped by a
  one-shot latch, pinned to the cheapest configured model, and interrupted if it overruns.
- Temporary projects, configuration, browser caches, screenshots and logs are deleted
  after success, failure or interruption. The summary is printed to the terminal.
  Pass `--out=.smoke/<name>` to retain screenshots, logs and a summary, or `--keep` to
  retain the whole scratch environment for debugging. `smoke:motion` follows the same
  cleanup rules. SIGKILL or a power loss cannot run teardown.

Useful flags: `--only=S3,S8` to run named steps, `--verbose` to print passing assertions,
`--kill-stale` with the same `--out` directory to stop its previous smoke process,
`--model=<key>` and `--paid-prompt=<text>` for the paid turn.

## Architecture

### Agent Loop

`src/harness/loop.ts` drives the main reasoning cycle:

```text
user input -> prepare records -> compact if needed -> build context -> call model -> run tools -> repeat
```

The loop keeps the current Promise-based architecture. Tool execution uses ordered batching: consecutive concurrency-safe tools run in parallel, while unsafe tools run one at a time as ordering barriers. `ToolRunner` owns tool-use, approval, and tool-result records.

### Context And Cache

`src/harness/contextBuilder.ts` assembles:

- static system instructions
- project context
- optional custom system text
- skills
- environment metadata
- current date
- post-compact restore context
- session history

Anthropic prompt caching defaults to `auto` on every Anthropic-compatible endpoint,
including proxies. Requests use the same cache markers regardless of the endpoint's hostname:

- the static system prompt block
- the final tool schema
- the final eligible message block

If an endpoint explicitly rejects prompt caching or `cache_control` with HTTP 400/422,
Hanekawa retries that request once without cache markers. Only a successful uncached
retry records the rejection, shared by all provider instances in the process for
the same endpoint URL and model. New sessions, model switches, and subagents reuse
that result; restarting the process clears it. Concurrent requests made before the
result is recorded may each probe and fall back independently. Unrelated errors use
the normal retry policy; zero cache hits do not disable caching.

Set `promptCaching` to `"auto"`, `"on"` (no compatibility fallback), or `"off"` on an
endpoint or model in `~/.myagent/config.json`. Model values override endpoint defaults.
`"on"` sends cache markers even if a rejection was previously recorded.
`MYAGENT_DISABLE_PROMPT_CACHING=1` disables Anthropic cache markers regardless of this
setting.

The existing 5-minute/1-hour TTL settings apply to compatible endpoints too; ordinary
caching does not send beta headers. Cache usage and cache-break diagnostics also run
on compatible endpoints. Missing cache usage is not treated as a zero hit; provider
debug output reports uncached input, cache creation, and cache reads separately.

OpenAI-compatible requests use a stable `prompt_cache_key` based on model, system prompt, and tools.

Context management stays client-side: Hanekawa does not send `context_management`
or `cache_edits` requests. It reserves 20,000 tokens for compact summaries, preserves
active conversation prefixes, clears old tool results after a long idle gap, and
starts auto-compaction near the effective-window limit. Historical turns are not
removed by position-only truncation.

### Providers

Provider code is split under `src/config/providers/`:

- `anthropicProvider.ts`
- `openaiProvider.ts`
- `anthropicPayload.ts`
- `openaiPayload.ts`
- `usage.ts`
- `debug.ts`
- `registry.ts`

The compatibility entrypoint remains `src/config/providers.ts`, so existing imports from `../config/providers.js` continue to work.

### Permissions

Every tool call is first graded by a risk classifier (`src/harness/risk/`), then the permission gate combines the grade with your rules and the session mode.

| Grade | Meaning |
|---|---|
| `readonly` | Changes nothing and only reads the workspace |
| `normal` | Ordinary edits, builds, installs, network, reads outside the workspace |
| `risky` | Irreversible or wide-reaching but routine: `git push --force`, `git reset --hard`, `rm -r`, publishing, `sudo`, writes outside the workspace, `.env` |
| `critical` | Destructive or persistent: `rm -rf ~`, `mkfs`, `curl … | sh`, private keys and cloud credentials, shell rc / `authorized_keys` / git hooks, Hanekawa's own permission config |

| Grade | `default` | `plan` | `auto` (Ask when needed) | `bypass` |
|---|---|---|---|---|
| readonly | allow | allow | allow | allow |
| normal | ask | file writes denied (the session plan file excepted), otherwise ask | allow | allow |
| risky | ask | as normal | ask | allow, with a reminder to the model |
| critical | ask, never remembered | deny | ask, never remembered | deny for a mass delete, otherwise allow with a reminder |

The composer chip cycles `default → plan → auto → bypass`. `readonly` is internal, used by built-in explore/plan subagents. A subagent is never looser than its parent. The old `acceptEdits` mode is now `auto`; existing settings and agent frontmatter migrate automatically.

Rules, in order of precedence:

1. A `deny` rule always denies, in every mode, and is never turned into a prompt.
2. An `ask` rule asks; `bypass` ignores it.
3. An `allow` rule covers `normal`. It covers `risky` only when the rule text itself is risky (`Bash(git push --force:*)`, `Edit(/etc/hosts)`); `Bash(git push:*)` does not. Nothing covers `critical`.

`bypass` trusts the model: its only guard is against mass deletion — removing `/`, the home directory, a direct child of either, a drive root or a workspace root, or a recursive delete whose target is only known at runtime (`rm -rf "$X"`, `xargs rm -rf`, a relative path after `cd "$X"`). `$HOME`, `$PWD` and `$(pwd)` are resolved before judging. Use `auto` for a mode with guard rails.

"Always allow" persists only for `normal`. `risky` can be allowed for the session, by exact command or path. `critical` offers neither.

File rules match against the resolved absolute path. A pattern starting with `/` or `~` is absolute; any other is relative to the project root, so `Read(.env)` matches only the root `.env` — write `Read(**/.env)` for every one. `Read`/`Edit` deny rules are also applied, best effort, to paths extracted from Bash commands.

`permissions.mode` and `mcp.trustedServers` in a project's `.myagent/settings.json` are ignored, with a diagnostic; set them in user or local settings. The `Config` tool cannot change the permission mode. `WebFetch` follows redirects only within the same host; a cross-host redirect is returned to the model, whose next request goes through the gate again.

### Tools

Built-in tools live in `src/tools/`. Each tool declares:

- `name`
- `description`
- `inputSchema`
- `riskLevel`
- optional `isConcurrencySafe`
- `execute()`

Permission levels are `safe`, `confirm`, and `dangerous`.

### Skills

Skills live in `.myagent/skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: debugging
description: Use when diagnosing bugs
allowedTools: [Read, Grep, Bash]
model: powerful
effort: high
attachments:
  - references/checklist.md
hooks:
  stop:
    - command: "echo skill finished"
---

Skill instructions go here. Use $ARGUMENTS where slash command arguments should appear.
```

Skills are discovered at startup and made available in two ways:

- the generic `Skill` tool, which lets the model load a named skill during a turn
- slash commands named from the skill frontmatter, such as `/debugging args`

Skill slash commands submit the skill body as a normal query in the background
while the transcript shows only the slash invocation, such as `/debugging args`.
`$ARGUMENTS` in the skill body is replaced with the slash command arguments;
when no placeholder is present, non-empty arguments are appended as
`Arguments: ...`. Skill bodies may include inline shell snippets like
``!`git status` ``; these run through the normal Bash tool permission gate
before the query is submitted.

Slash skills can also declare text `attachments`, `hooks`, `allowedTools`,
`model`, and `effort` in frontmatter. These options apply only to that skill
turn: `allowedTools` filters the model-visible and executable tool set, `model`
and `effort` are temporary overrides, and hooks are merged with the session
hooks for that turn. Attachment paths are UTF-8 text files resolved inside the
skill directory and appended to the prompt. Built-in slash commands take
precedence when names conflict. Frontmatter `attachments` remain UTF-8 text files; image and PDF
attachments are not supported there.

### Sessions

Sessions are stored in `~/.myagent/projects/<key>/sessions/` as metadata plus JSONL records. Records include messages, tool uses, tool results, approvals, and compact boundaries.

### Rewind

`/rewind` steps back to an earlier prompt. It can restore the conversation, the
code, or both.

Restoring code restores **only the files the agent's write tools changed**
(`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Delete`). Before each such write
the previous contents are copied to `~/.myagent/file-history/<session-id>/`, and
a rewind puts those copies back — deleting files the agent created after the
chosen point.

`Bash` is covered only where the target is unambiguous from the command text:
output redirections (`> f`, `>> f`, `2> f`, `&> f`), `tee`, and non-recursive
`cp`/`mv`. A command that builds its target with a variable, a glob, or a
command substitution, and anything a script writes indirectly, is not captured.

Everything else is left exactly as it is: your own edits in an editor, build
output, and `git` operations are never captured and never rolled back. A rewind
undoes the agent's edits, not the state of your worktree.

## Useful Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1`: log provider request and response payloads
- `MYAGENT_PROMPT_CACHE_1H=1`: enable 1-hour Anthropic prompt cache TTL
- `MYAGENT_DISABLE_PROMPT_CACHING=1`: disable prompt caching
- `MYAGENT_MAX_OUTPUT_TOKENS=N`: override max output tokens
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N`: override Anthropic stream idle timeout

## Current ToolSearch Prompt State

ToolSearch prompt copy in `src/tools/ToolSearchTool/prompt.ts` uses plain ASCII
punctuation so deferred-tool instructions do not expose mojibake artifacts to
the model. `test/tools.test.ts` includes a regression check for this prompt
text.

### ToolSearch Configuration

- `HANEKAWA_TOOL_SEARCH` - mode: `true`/`1`/unset=always, `false`/`0`=off, `auto`=auto, `auto:N`=auto with N% threshold
- `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT` - auto mode threshold percentage (default 10)
- `auto:N` takes priority over `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT`
- `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS=1` disables beta-only dynamic ToolSearch payload fields

Dynamic ToolSearch is enabled only for native Anthropic providers that support `tool_reference`, using the `advanced-tool-use-2025-11-20` beta header. OpenAI and Anthropic-compatible proxy endpoints fall back to complete inline tool schemas instead of dynamic loading.

## Model Context Windows

Set `contextWindow` explicitly on a model when its provider supports a context
window other than the default 200,000 tokens:

```json
{
  "models": {
    "mimo-v2.5": {
      "endpoint": "xiaomi",
      "model": "mimo-v2.5",
      "contextWindow": 1000000
    }
  }
}
```

When omitted, Hanekawa uses 200,000. The configured value controls context
budgeting, history selection, compaction thresholds, ToolSearch thresholds, and
status display; Hanekawa does not infer it from the model name.

### The 1M context beta header

Anthropic's 1M context window is a **request header**, not part of the model id:
`anthropic-beta: context-1m-2025-08-07`. Some Anthropic-compatible endpoints only
serve their 1M models when it is present, while vendors that are already 1M by
default may reject an unrecognized beta. So it is an explicit per-model switch,
off by default — `longContext1m` in config, or 「1M 上下文请求头」 in the desktop
settings screen's model form:

```json
{
  "models": {
    "sonnet-1m": {
      "endpoint": "proxy",
      "model": "claude-sonnet-4-6",
      "contextWindow": 1000000,
      "longContext1m": true
    }
  }
}
```

The two fields are **orthogonal and both usually wanted**: `longContext1m` only
adds the header, `contextWindow` is the local token budget. Setting one does not
change the other. The switch is read by the `anthropic` provider only, and —
unlike every other beta Hanekawa sends — it applies to custom `baseUrl` endpoints
too, since those are exactly the ones that need it.
