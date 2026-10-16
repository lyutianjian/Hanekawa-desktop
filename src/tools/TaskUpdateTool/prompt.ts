export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Update one task in the task list.

Usage:
- Parameters are \`taskId\` (required) plus any of \`status\`, \`subject\`, \`description\`, \`activeForm\`, \`owner\`, \`addBlocks\`, \`addBlockedBy\`, \`metadata\`. Any other key is rejected.
- \`status\` moves \`pending\` -> \`in_progress\` -> \`completed\`; use \`deleted\` to drop a task that turned out to be irrelevant.
- Mark a task \`in_progress\` before you start on it, not after; keep exactly one task in progress while you work. When you finish one, mark it \`completed\` and the next \`in_progress\` in the same response. Do not jump from \`pending\` to \`completed\`.
- Never batch status changes at the end: the user watches the list live.
- Marking a task \`completed\` reports what remains and what is next.
- Updating a task left from an earlier request carries that whole list into the current one, so a later TaskCreate adds to it instead of replacing it.
- Mark a task completed only when it is fully done — not while tests fail, the implementation is partial, or errors remain.
- \`addBlocks\` and \`addBlockedBy\` take arrays of task IDs and are additive.
- Example: \`{"taskId": "1", "status": "in_progress"}\`
`
