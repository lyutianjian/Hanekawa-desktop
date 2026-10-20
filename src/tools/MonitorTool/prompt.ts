import { MONITOR_MAX_PENDING_LINES } from '../../services/backgroundTasks/registry.js'

export const MONITOR_TOOL_NAME = 'Monitor'
export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000

// ASCII only, like the Bash description.
export const DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event: you keep working and the events arrive in the conversation at your next step. Events come from the script, never from the user.

- Parameters are \`command\` (required), \`description\` (required), \`timeout_ms\` and \`persistent\`. Any other key is rejected.
- Events reach you only while you are working. After you end your turn they wait, without waking you, and arrive with the user's next message. Do not end your turn to wait for an event: to wait for one thing before you answer, run a foreground Bash command that exits when it happens, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`.
- The monitor is killed after \`timeout_ms\` (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}) unless the script exits first; you get one notice when it ends. \`persistent: true\` removes the deadline for session-length watches. Stop a monitor early with KillShell, using the task id this tool returns.

Pick by how many notifications you need:
- One ("tell me when the build finishes"): not Monitor. Use a foreground Bash \`until\` loop, or Bash with \`run_in_background\` and a command that exits when the condition holds.
- One per occurrence, indefinitely ("each ERROR line in the dev server log while I try the change"): Monitor with an unbounded command (\`tail -f\`, \`while true\`).
- One per occurrence until a known end ("each CI check result, stop when the run completes"): Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream; exit ends the watch.
  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"
  # Each CI check as it lands; exits when the run completes
  prev=""; while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur"); prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

- Do not use an unbounded command for a single notification: \`tail -f\` and \`while true\` never exit, so the monitor stays armed until its deadline. \`tail -f log | grep -m 1\` does not fix this.
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. Never pipe into \`head\`.
- In poll loops, survive transient failures (\`curl ... || true\`). Poll remote APIs every 30s or more, local checks every 0.5-1s.
- Only stdout is the event stream. Stderr goes to the output file (readable with Read). For a command you run directly, merge it with \`2>&1\` so its failures reach your filter.
- Write a specific \`description\` ("errors in deploy.log", not "watching logs"); it labels every event.

Silence is not success. When watching for an outcome, the filter must match every terminal state, not only the happy path: a monitor that greps only for the success marker stays silent through a crash, a hang or an unexpected exit.
  # Wrong: silent on crash
  tail -f run.log | grep --line-buffered "elapsed_steps="
  # Right: progress plus the failure signatures you would act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|Killed|OOM"

Output volume: every line costs conversation context, so filter to the lines you would act on and never stream raw logs. Lines arriving between two of your steps are merged into one event; past ${MONITOR_MAX_PENDING_LINES} lines the oldest are dropped, and a monitor that overflows while you are working is stopped. Re-arm it with a tighter filter.

The script runs in the same shell environment as Bash, in the session working directory.`
