export const DESCRIPTION = 'Create one or more tasks in the task list'

export function getPrompt(): string {
  return `Create structured tasks to track in the current session. One call creates the whole list.

The list is shown to the user as a live checklist of what you are doing for their current request: a short, local plan of the next steps, not a commitment for the whole session.

Usage:
- The only parameter is \`tasks\`, a non-empty array. Each item has \`subject\` and \`description\` (both required), plus the optional \`activeForm\` and \`metadata\`. Any other key is rejected.
- \`subject\` is a brief imperative title, \`description\` says what needs to be done, and \`activeForm\` is the present-continuous wording shown in the spinner.
- Put every task you plan into a single call rather than one call per task, in the order you will do them; IDs are assigned in array order.
- Use for complex multi-step work (3+ steps), plan mode, or user-requested lists. Skip it for one trivial task or a conversational request.
- Example: \`{"tasks": [{"subject": "Add schema", "description": "..."}, {"subject": "Wire the view", "description": "..."}]}\`
- Tasks start as \`pending\`. Set status and dependencies with TaskUpdate.

The list belongs to one request:
- Your first TaskCreate after a new user request replaces the list left from earlier, finished or not, and IDs restart at 1. There is no need to delete the old tasks first.
- A message the user sends while you are still working (it arrives after a tool result, not after your final reply) amends the current request and keeps its list.
- To carry on with the earlier list instead, touch it with TaskUpdate first (for example, mark the task you resume \`in_progress\`); the list then belongs to this request, and TaskCreate adds to it.
- Within one request TaskCreate only adds. Check TaskList first so you do not create a duplicate.

The plan is meant to change. When what you learn changes it, add the new steps, mark the ones that no longer apply \`deleted\`, and reword the ones that shifted. Never keep working down a list that no longer matches what you are doing.
`
}
