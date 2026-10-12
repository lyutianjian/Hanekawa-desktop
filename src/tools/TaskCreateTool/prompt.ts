export const DESCRIPTION = 'Create one or more tasks in the task list'

export function getPrompt(): string {
  return `Create structured tasks to track in the current session. One call creates the whole list.

Usage:
- The only parameter is \`tasks\`, a non-empty array. Each item has \`subject\` and \`description\` (both required), plus the optional \`activeForm\` and \`metadata\`. Any other key is rejected.
- \`subject\` is a brief imperative title, \`description\` says what needs to be done, and \`activeForm\` is the present-continuous wording shown in the spinner.
- Put every task you plan into a single call rather than one call per task; IDs are assigned in array order.
- Use for complex multi-step work (3+ steps), plan mode, or user-requested lists. Skip it for one trivial task or a conversational request.
- Example: \`{"tasks": [{"subject": "Add schema", "description": "..."}, {"subject": "Wire the view", "description": "..."}]}\`
- Tasks start as \`pending\`. Set status and dependencies with TaskUpdate.
- Check TaskList first so you do not create a duplicate.
`
}
