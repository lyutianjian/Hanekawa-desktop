export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Update one task in the task list.

Usage:
- Parameters are \`taskId\` (required) plus any of \`status\`, \`subject\`, \`description\`, \`activeForm\`, \`owner\`, \`addBlocks\`, \`addBlockedBy\`, \`metadata\`. Any other key is rejected.
- \`status\` moves \`pending\` -> \`in_progress\` -> \`completed\`; use \`deleted\` to drop a task that turned out to be irrelevant.
- Mark a task completed only when it is fully done — not while tests fail, the implementation is partial, or errors remain.
- \`addBlocks\` and \`addBlockedBy\` take arrays of task IDs and are additive.
- Example: \`{"taskId": "1", "status": "in_progress"}\`
`
