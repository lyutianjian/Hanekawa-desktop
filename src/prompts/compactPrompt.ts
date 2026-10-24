/**
 * Structured compact prompt for LLM-based conversation summarization.
 * Adapted from Claude Code's compact prompt with 9-section structure.
 */

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`

const COORDINATOR_COMPACT_PROMPT = `Your task is to create a summary of this coordination conversation so that you can keep coordinating the user's project without losing what was agreed. You direct threads (separate sessions); this conversation holds the user's intent and your commitments, not the work itself.

Your summary should include the following sections:

1. Goals and Instructions: The user's long-term goals and every standing instruction, quoted verbatim where wording matters (preferences, constraints, things not to do).
2. Decisions: Decisions made and why, including options that were rejected.
3. Assignments and Commitments: Which goal was handed to which thread (by id and name) and why, and anything you promised the user.
4. Questions Waiting on the User: Questions you asked that are still unanswered, with the options offered.
5. Pending Follow-ups: Things still to do, check or report that have not been handled yet.
6. All user messages: List the user's messages that are not tool results, briefly, to preserve their changing intent.

Do not record thread status. A fresh board is restored after compaction, and anything you write about running, finished or blocked threads would be stale. Reference threads only by id and name where an assignment or commitment needs them.

Format the output as:

<summary>
1. Goals and Instructions:
   [...]

2. Decisions:
   [...]

3. Assignments and Commitments:
   [...]

4. Questions Waiting on the User:
   [...]

5. Pending Follow-ups:
   [...]

6. All user messages:
   [...]
</summary>

There may be additional summarization instructions provided in the included context. If so, follow them when creating the summary.
`

const THREAD_COMPACT_PROMPT = `Your task is to create a summary of this coordination thread so that you can continue its assigned task after compaction without losing what was decided.

Your summary should include the following sections:

1. Assigned Task and Current Scope: The task this thread was started with, and the scope in force now. Later instructions from the user or the coordinator override the original wording; say so where they differ.
2. Acceptance Criteria: What counts as done, quoted verbatim where the wording matters.
3. Work Completed: What is finished and verified, and where its result lives (files, commits, branch).
4. Work Remaining: What is still to do, in order, including anything explicitly deferred.
5. Open Questions and Blockers: Questions asked and not yet answered, and anything that stopped progress.
6. Cancellations and Conclusions: Work the user or the coordinator cancelled, replaced or declared finished. Do not restore it as pending.

State the branch you work on when you have a worktree. Compaction does not mean the task is finished. Do not claim completion you cannot support from the conversation.

Format the output as:

<summary>
1. Assigned Task and Current Scope:
   [...]

2. Acceptance Criteria:
   [...]

3. Work Completed:
   [...]

4. Work Remaining:
   [...]

5. Open Questions and Blockers:
   [...]

6. Cancellations and Conclusions:
   [...]
</summary>

There may be additional summarization instructions provided in the included context. If so, follow them when creating the summary.
`

export type CompactPromptVariant = 'default' | 'coordinator' | 'thread'

const COMPACT_PROMPTS: Record<CompactPromptVariant, string> = {
  default: BASE_COMPACT_PROMPT,
  coordinator: COORDINATOR_COMPACT_PROMPT,
  thread: THREAD_COMPACT_PROMPT,
}

/**
 * Returns the full structured compact prompt for LLM-based summarization.
 * The text-path summarization request is built with `tools: []`, so the
 * prompt says nothing about tool use; see `getSharedPrefixCompactPrompt`.
 *
 * @param customInstructions - Optional user-provided instructions appended after the
 *   base prompt (e.g. from CLI args `/compact [instructions]` or pre-compact hook output).
 */
export function getCompactPrompt(
  customInstructions?: string,
  variant: CompactPromptVariant = 'default',
): string {
  let prompt = COMPACT_PROMPTS[variant]
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }
  return prompt
}

/**
 * The compact prompt for a request that reuses the conversation itself as its
 * context — same system, same tools, same history — so the summary reads the
 * cached prefix instead of paying for the conversation again as text. The
 * tools are there only to keep that prefix identical, hence the instruction.
 */
export function getSharedPrefixCompactPrompt(
  customInstructions?: string,
  variant: CompactPromptVariant = 'default',
): string {
  return `${getCompactPrompt(customInstructions, variant)}

Respond with the summary as plain text. Do not call any tools.`
}

/**
 * Merge user-provided and hook-provided compact instructions.
 * Hook instructions are appended after user instructions when both are present.
 * Returns undefined if neither source provides instructions.
 */
export function mergeHookInstructions(
  userInstructions: string | undefined,
  hookInstructions: string | undefined,
): string | undefined {
  if (!hookInstructions) return userInstructions || undefined
  if (!userInstructions) return hookInstructions
  return `${userInstructions}\n\n${hookInstructions}`
}

/**
 * Formats the compact summary by replacing <summary> XML tags with readable
 * section headers. Gracefully handles raw text that doesn't contain the
 * expected tags.
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary

  // Defensive parse for sessions recorded while the prompt still asked for an
  // <analysis> scratchpad. Nothing requests one now.
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // Extract and format summary section
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  formatted = formatted.replace(/\n\n+/g, '\n\n')

  return formatted.trim()
}
