import {
  SLEEP_BLOCK_THRESHOLD_SECONDS,
  resolveBashTimeoutMs,
} from './constants.js'

/**
 * The `Bash` tool's description.
 *
 * Three of the rules below are things the tool already enforces and the old
 * three-sentence description never said, so the model could only learn them by
 * failing: the working directory does not survive a call, stdin is closed, and
 * a leading `sleep` past the threshold is refused outright. The rest ports
 * Claude Code's guidance on git safety, command chaining, paths and sleeping.
 *
 * It deliberately does not call `describeShell()`. That triggers the lazy
 * `existsSync`/`spawnSync` probe, and this runs from `getBuiltinTools()`, which
 * would move the probe from the first prompt build to every runtime creation.
 * The prompt's `# Environment` block already names the shell.
 *
 * ASCII only: this text is quoted into shell-shaped answers, and
 * `ToolSearchTool/prompt.ts` has the mojibake scars to show for punctuation.
 */
export function buildBashDescription(): string {
  const defaultTimeout = resolveBashTimeoutMs()
  return `Executes a bash command and returns its output.

- Parameters are \`command\` (required), \`description\`, \`timeout\`, \`run_in_background\`, and optional \`env\` (key-value object). Any other key is rejected.
- Always pass \`description\`: what the command does, in active voice, shown to the user when they approve it. Do not echo the command, its flags or paths. Keep simple commands to 5-10 words ("List files in current directory", "Install package dependencies"); for piped or obscure commands, add enough context to say what they achieve ("Find and delete all .tmp files recursively").
- Each call starts in the session working directory. \`cd\`, environment variables, functions and aliases do NOT carry over to the next Bash call. Prefer absolute paths, or chain with \`&&\` inside a single call. Quote paths containing spaces: \`cd "path with spaces/file.txt"\`.
- stdin is closed. Interactive commands (password prompts, pagers, editors, \`-i\` flags) will hang or fail. Pass flags that avoid interaction, such as \`--no-pager\`.
- Large output is truncated.

# Preferring dedicated tools
Avoid running \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` through this tool unless explicitly instructed, or after you have verified a dedicated tool cannot do the job. The dedicated tools let the user review and approve your work:
 - File search: Glob (NOT find or ls)
 - Content search: Grep (NOT grep or rg)
 - Read files: Read (NOT cat, head, or tail)
 - Edit files: Edit (NOT sed or awk)
 - Write files: Write (NOT echo redirection or cat with a heredoc)
 - Communication: output text directly (NOT echo or printf)

# Issuing multiple commands
 - Independent commands: make multiple Bash tool calls in a single message so they run in parallel.
 - Dependent commands: use one call and chain them with \`&&\`.
 - Use \`;\` only when you need them sequential but do not care whether earlier commands fail.
 - Do NOT use newlines to separate commands. Newlines inside quoted strings are fine.

# Timeouts and background work
 - \`timeout\` is in milliseconds: default ${defaultTimeout}, no maximum.
${process.platform === 'darwin' ? ' - macOS has no `timeout` command; set the `timeout` parameter instead.\n' : ''} - A command still running after \`timeout\` is moved to the background (except \`sleep\`); you are notified when it finishes, so continue with other work.
 - The user may send a message while a foreground command is still running. That command is moved to the background and keeps running; do not restart it, do not wait for it, and answer what the user asked.
 - Set \`run_in_background: true\` for servers and long jobs; no trailing \`&\` is needed.
 - A background command's output goes to a file named in the result; Read it to check progress. The finish notification includes the last lines. Stop a task with KillShell.
 - To be told about each line a long-running process prints (errors in a log, each CI step), use Monitor instead.

# Avoid sleeping
 - \`sleep N\` with N >= ${SLEEP_BLOCK_THRESHOLD_SECONDS} as the first command is rejected. Use \`run_in_background\` instead.
 - Do not sleep between commands that can run immediately.
 - Do not poll a background task you started; you will be notified when it completes.
 - To wait for a condition, such as a server coming up, make one call that loops until it holds and set \`timeout\`: \`until curl -sf localhost:3000 >/dev/null; do sleep 1; done\`.
 - Do not retry a failing command in a sleep loop. Diagnose the root cause.

# Git
 - NEVER update the git config.
 - NEVER run destructive git commands (\`push --force\`, \`reset --hard\`, \`checkout .\`, \`restore .\`, \`clean -f\`, \`branch -D\`) unless the user explicitly requests them.
 - NEVER skip hooks (\`--no-verify\`) or bypass signing (\`--no-gpg-sign\`, \`-c commit.gpgsign=false\`) unless the user explicitly asks. If a hook fails, fix the underlying issue.
 - Prefer a new commit over amending. A failed pre-commit hook means the commit did NOT happen: fix the issue, re-stage, and create a NEW commit. Never \`--amend\` to recover; it would rewrite the previous commit and can destroy work.
 - When staging, name files explicitly rather than \`git add -A\` or \`git add .\`, which can pull in secrets (.env, credentials) or large binaries.
 - Interactive flags are not supported in this environment (\`git rebase -i\`, \`git add -i\`).
 - Only commit when the user asks, and only push when the user asks.
 - Use the \`gh\` CLI for GitHub operations (pull requests, issues, checks, releases).`
}
