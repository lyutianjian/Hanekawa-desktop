export const KILL_SHELL_TOOL_NAME = 'KillShell'

export const DESCRIPTION = `Terminate a running background Bash task or Monitor, and its child process tree.

Usage:
- The only parameter is \`task_id\`, the id Bash returns for a background command or Monitor returns for a monitor. Any other key is rejected.
- Killing a task that already finished is not an error; it reports the status it was already in.
- Only shell tasks can be killed here. Agent tasks are a different kind and are refused.
- The task's output file stays readable after it is killed.`
