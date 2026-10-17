export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Get one task by ID from the task list.

Usage:
- The only parameter is \`taskId\`. Any other key is rejected.
- Use it to check what a task depends on.
- Returns subject, description, status, blocks, and blockedBy. Verify blockedBy is empty before starting the work.
- Use TaskList when you do not know the ID yet.
`
