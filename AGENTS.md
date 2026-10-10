# AGENTS.md

This file provides implementation guidance for Codex and other coding agents when changing Hanekawa.

Hanekawa (package `myagent`) is a self-hosted coding agent with Ink/React TUI and Electron desktop frontends. It supports persistent sessions, permission-gated tools, subagents, skills, MCP, and context compaction. User-facing behavior belongs in `README.md`.

## Commands

Requires Node.js 22+. Run `npm install`; `postinstall` applies the tracked `patch-package` patches.

```bash
npm run dev:tui
npm run start:desktop
npm run typecheck
npm run build
npm run build:desktop
npm run test
npm run smoke:desktop
npm run smoke:browser
```

Focused tests:

```bash
npm test -- test/<file>.test.ts
npm test -- --test-name-pattern="pattern" test/<file>.test.ts
```

Tests use `node:test`/`node:assert`; there is no lint script. TypeScript configs are intentionally split across base, build, preload, renderer, and DOM tests—keep their `rootDir`/`exclude` boundaries intact.

Use `npm test` for focused runs too: `scripts/test.mjs` gives child processes a disposable home/temp root and removes it on success, failure or interruption. Test fixtures must use scratch project paths for writes, never the repository's `process.cwd()`.

## Architecture

```text
tui/ or desktop/ -> runtime/ + harness/ -> config/providers/
                         |       |
                   sessions/  prompts/  tools/  services/
```

- `harness/`: agent loop, context, permissions, tools, hooks, compaction.
- `runtime/`: project/session lifetimes, queues, commands, protocol.
- `sessions/`: append-only JSONL records through `RecordStream`.
- `prompts/`: prompt composition and budgets; never imports `harness/`.
- `config/`: settings, models, routing, retries, providers.
- `tools/`: one directory per built-in (`GrepTool/`, `FileEditTool/`, ...) plus shared helpers at the root, all registered in `src/tools/index.ts`. A shell may add tools the shared registry cannot build through `BootstrapOptions.extraTools` — the desktop's `Browser`, which needs a window; such a tool reaches its host through a pure-type interface in `runtime/protocol/`, never by importing Electron.
- `services/`: project context, file history, background tasks, skills, memory.
- `tui/`: Ink shell; `desktop/`: Electron main, preload, shell host, renderer.

`services/` may depend on `tools/`, not the reverse. The harness uses `RecordStream`, never `SessionStore` directly. Keep decisions in the owning runtime/model layer, not Electron entry points or views.

## Runtime and sessions

- Share one `ProjectRuntime` per `cwd`; `ProjectDirectory` must not duplicate it. Settings and agent definitions are read live; MCP containers/tool arrays are mutated in place.
- A session scope has a working dir (tools, Bash, permission workspace boundary) separate from its project dir (data dirs: plans, memory, spill, transcripts, diagnostics, sessions). `SessionMeta.coordination` carries role/threadId/workingDir and must be set before a lane opens.
- Each conversation owns its scope, pane, bridge, permission gate, prompt cache, loop, tool runner, context builder, and record stream. Never share these across sessions or subagent runs.
- `agent.contextManagement` and `permissions.mode` are snapshotted when a session scope is built; reloads do not change open sessions.
- Lifecycle order: install a replacement runtime before disposing the old one; interrupt a pane before releasing its scope; close the workspace before the project; await already-closing projects in `shutdownAll`.
- `main.ts ensureProject` is the only bootstrap path. It registers roots in `~/.myagent/projects.json` in added order; startup always opens a new empty session and uses a registered or explicit root, never bare `process.cwd()`.
- The home directory is the global workspace (最近); use `projectIsGlobal`, never display-name matching. The sidebar reads the registry and global session index live; only `remove-project` removes an added project row.
- Resolve root-keyed commands through `ShellHost.cwdForRoot` or `ensureEntryForRoot`, never `knownCwdForRoot` alone.
- Closing a lane releases a runtime but does not delete the session or stop project background tasks. Use the dedicated session/project deletion paths so all artifacts are removed.

## Coordination

- One coordinator session per project (pointer in `<projectData>/coordination/coordination.json`, file-locked); threads are ordinary sessions. Thread worktrees live under `~/.myagent-worktrees/<projectDataKey>/<threadId>` on branch `hanekawa/<slug>-<threadId>`.
- Coordination tools reach the host through the pure `CoordinationHost` interface (`runtime/protocol/coordinationHost.ts`), injected via `extraTools` and gated by `Tool.sessionRoles`.
- Turn origins are `user|coordinator|wake`; coordinator messages are never steered into a user-driven turn. Wakes go only through the wake engine/`decideWake`, not background notifications.
- Board snapshots and thread notes reach the coordinator as `coordination_update` records, delivered at step boundaries (and before a user/wake message) via `peekCoordinationUpdate` then `ackCoordinationUpdate` after the append; unsent snapshots coalesce, sent ones are never rewritten (cache prefix).
- The shell pushes `coordination-threads` to the renderer, coalesced per root. Notes are wrapped in an app-added `<thread-note>` marker, parsed by `renderer/model/threadNotes.ts` into cards; keep the two in step.
- Merges run in the app via git, never through the model: dirty main tree refuses, conflict runs `git merge --abort`.
- Thread/coordinator sessions refuse `/clear`, `/resume` and session switches. Deleting a thread marks it stale; deleting the coordinator ends the project's coordination: every thread session and worktree and the coordination directory go with it.

## Loop, tools, and context

- `AgentLoop.run()` and `runTool()` use the shared enqueue path and one in-flight guard. Preserve abort/error and `tool_result` semantics.
- `ToolRunner` settles approval, result, and post-use records for every failure, denial, abort, or hook block. Only the loop batches contiguous safe calls.
- Repair unmatched `tool_use`/`tool_result` pairs before provider calls. A model switch invalidates model-dependent prompt/cache state; changed compaction context needs a fresh token count.
- Compaction retains the latest user message. Automatic failures are fail-open behind the per-session circuit breaker. Cache sources and module state never cross sessions, streams, or projects.
- File tools read through `src/tools/textFile.ts` and write through `writeTextFile`: normalize reads to LF, preserve encoding/line endings on write, and keep `Read`’s whole-file state available to `Edit`.
- Every built-in tool is a `src/tools/<Name>Tool/` directory: the implementation, and a `prompt.ts` holding its description plus any tool-name constants. Descriptions name every accepted parameter and every capability the model's Claude Code prior expects but this tool lacks.
- `src/tools/inputAliases.ts` normalizes input before permissions, hooks, display, records, or execution read it. Renaming an alias onto a real parameter beats dropping it; dropping is for keys no parameter could honour. The prompt’s shell line comes from `describeShell()` in `src/tools/BashTool/BashTool.ts`.
- Project instructions are `AGENTS.md`/`CLAUDE.md` and `.myagent/rules/*.md` walked upward from `cwd`, first match per directory, outermost first; local `AGENTS.local.md`/`CLAUDE.local.md` is read last.

## Permissions and configuration

- Modes are `default`, `plan`, `auto`, `bypass`, plus internal `readonly` (built-in subagents and the coordinator scope, whose mode is locked via `PermissionGate` `lockMode`); thread scopes start in `auto`. `acceptEdits` is a legacy alias read as `auto` by `settings.ts` and `agentDefinitionLoader.ts`; never reintroduce it.
- A call is graded `readonly`/`normal`/`risky`/`critical` by the pure classifier in `src/harness/risk/`; `PermissionGate` only combines that grade with rules and mode (order and table in README "Permissions"). The gate never analyzes commands itself.
- A deny rule is absolute in every mode and never becomes a prompt. `critical` never gets allow, except in `bypass`, which refuses only a mass delete (`MASS_DELETE_CODES`: a root, home or workspace directory, or a recursive delete whose target is only known at runtime). `bypass` and `readonly` never ask: `bypass` ignores ask rules, `readonly` denies on them. Persisted allow rules cover `normal` only; `risky` memory is per-session and exact; `critical` is never remembered.
- Workspace boundaries use realpath of the nearest existing ancestor. File rules match resolved absolute paths; `Read`/`Edit` deny rules also apply to paths extracted from Bash. Cover new classifier behavior with the table-driven tests and the invariants in `test/permissionModes.test.ts`.
- Project-layer `permissions.mode` and `mcp.trustedServers` are ignored. `Config` must not expose `permissions.mode`. Preserve `WebFetch` host scoping (same-host redirects only) and tool-family rule aliases (`Edit` → write tools, `Read` → `Grep`/`Glob`).
- `config.json` is global only. Models, endpoints, routing, and `agent.*` belong in `ConfigService`; migrate any project leftovers before the first load.
- Settings groups concatenate/union across layers, except `skills.disabled`, which is replaced per layer. Provider construction stays in `src/config/providers/registry.ts`.
- Preserve provider capability checks, retry/fallback propagation, and reference repair when models/endpoints are deleted. `ModelConfig.longContext1m` and `contextWindow` are independent.

## TUI, protocol, and desktop

- `src/tui/entrypoints/tui.tsx` is the TUI wiring point; `SessionController` owns turn lifecycle. Session switches, `/clear`, and `/resume` use the shared choreography and re-check blocking UI requests.
- Use the shared theme and clock. `src/runtime/protocol/` is Electron-free; wire values survive `structuredClone`, commands use strict schemas, and dispatch is exhaustive with `assertNever`.
- Renderer code must not value-import `harness/`, `services/`, `sessions/`, `commands/`, or `tui/`. Put pure decisions in `renderer/model/`, DOM/event wiring in `renderer/dom/` or the app shell, and settle every blocking request.
- One `BrowserWindow` multiplexes pane lanes over one transport; desktop `ShellHost` owns cross-project topology and all lane exits use the common detach/dispose path.
- Settings changes follow `mutate -> save if config changed -> reload -> after-reload action -> optional refresh/rebuild`, with unique change kinds, optimistic pending state, and one wire scope per category (except renderer-local `appearance`).
- Window views derive identity from `WireLaneInfo`. Context occupancy uses `AgentLoop.getContextBudget().usableContextWindow`, not the raw model window. `open-in-editor` resolves the real `entry.cwd`.
- `TokenUsage`'s three input fields are disjoint: uncached input, cache writes (`cacheCreationInputTokens`, optional — absent means the provider does not report writes, never zero writes), cache reads. Add them only through `promptTokens()`, and take the hit rate only from `cacheHitRate()`, whose denominator is that same sum: a write is a miss that was paid for. Usage arithmetic preserves absence rather than materializing a zero.
- Context occupancy is `promptTokens(usage.lastRequest)`, pushed per provider response through `RecordProxy.onRequestUsage` and seeded from the metrics sidecar for a session this process never ran — `loadLastRequestUsage` for the request, `loadSessionTotals` for the running total, which only lands while the total is still empty. A mid-turn report moves `lastRequest` only — the totals stay on the end-of-run accounting, or every request is counted twice. `SessionController.contextUsed()` adds a record-only estimate of what came after the last request; with no request yet it estimates the records kept after the last compaction plus the system prompt. It is the last resort, not a source.
- The desktop readout pairs a cumulative count with the *last request's* hit rate; the session-cumulative rate lives in the hover. A cumulative rate can only fall — the cold first request, every compaction and every subagent prompt sit in its denominator forever — so it answers how the session went, not whether the cache is working now.
- `scripts/smoke-browser.mjs` runs `scripts/smoke/browser.cjs` in Electron against `DesktopBrowserHost`, a loopback server and a disposable profile removed after Electron exits: the agent-browser paths only a real renderer has (beforeunload refusal, hit testing, native `<select>`, key chords). Its entry is CommonJS because an ESM Electron entry never starts in a headless Linux container.
- `scripts/smoke-desktop.mjs` exercises real Electron behavior with scratch projects, a disposable home and a private profile. Teardown stops children before removing these and reports every cleanup failure. Real global config/settings/projects stay untouched; reports are retained only with explicit `--out` or `--keep`.

## Renderer invariants

- `<cwd>/.myagent/` holds only user-written project configuration; nothing at runtime creates it. Runtime data (sessions, tool-result spills, attachments, plans, diagnostics) and personal settings (`settings.local.json`, `agents.local/`) live under `getProjectDataDir(cwd)` = `~/.myagent/projects/<key>/`; global settings/config under `~/.myagent/`. Sessions are append-only JSONL. File tools resolve paths through `resolveToolPath`, which admits only the session's own spill dir, the plans dir and the project's coordination notes dir outside `cwd`. `SessionStore.init()` migrates legacy `<cwd>/.myagent/` runtime entries (`sessions/legacyProjectData.ts`): copy, verify, then delete; never overwrite.
- `/rewind` restores from per-session file history in `~/.myagent/file-history/`, never from the worktree: write tools call `trackFileEdit` *before* writing, `makeSnapshot` opens a snapshot per turn, and restores are addressed by `messageId`. Only files the agent's tools touched are captured. Keep backups deduplicated by version, collect a backup only once no surviving snapshot names it, and keep every per-file failure local — there is no session-wide disable.
- Changes to `hasOverlay` or `isStreaming` call `onShellChanged`. Streaming turns post `session-event` and `snapshot`; keep frame/render-signature work bounded.
- Every popover closes three ways: a press outside it (`dom/dismiss.ts`'s `onPressOutside`, scoped to the popover **and its trigger**, never to the bar around them), `focusout`, and Escape. A `focusout` with `relatedTarget === null` is the view's own repaint and must be ignored, and a `focus()` inside a paint goes last — it fires `focusout` synchronously, and a handler that repaints in answer re-enters the paint.
- Reuse the existing renderer model/view helpers, styling tokens, overlay behavior, and focus rules. Prefer pure model tests; DOM tests use `test/helpers/domStub.ts`.
- Markdown math is split in two: `renderer/model/markdown.ts` only *finds* TeX (a `marked` extension on a private `Marked` instance, four delimiter pairs) and `dom/markdownView.ts` typesets it with `katex.render` — the DOM-tree form, never `renderToString`, which `dom/dom.ts`'s innerHTML ban rules out. `katex.css` and its woff2 are copied out of `node_modules` by `scripts/copy-desktop-assets.mjs`, woff/ttf sources stripped.

## Workflow and conventions

Read the owning module, nearest tests, and relevant types before editing. Reuse existing helpers, registries, DTOs, and model functions. Preserve unrelated worktree changes and add focused regression coverage.

Run the narrowest relevant tests first; run `npm run typecheck` and the full suite for shared/cross-layer changes. Reset module caches when tests change environment, project, or session scope.

- Use `.js` extensions for relative imports.
- Import strict schemas from `zod/v3`.
- Keep `ink+7.0.6.patch` and `wrap-ansi+10.0.0.patch` paired.
- `AGENTS.md` is the only guide this repo keeps. The runtime still reads `CLAUDE.md` from *other* projects; there is no second copy here to maintain.
## Instructions

For simple or low-risk tasks, reduce writing unnecessary tests and avoid overly defensive programming.
