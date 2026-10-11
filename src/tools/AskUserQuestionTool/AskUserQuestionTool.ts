import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH, ASK_USER_QUESTION_TOOL_NAME } from '../toolNames.js'
import { buildAskUserQuestionDescription } from './prompt.js'

const questionOptionSchema = z.object({
  label: z.string().min(1).describe(
    'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
  ),
  description: z.string().describe(
    'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  ),
  preview: z.string().optional().describe(
    'Optional preview content rendered when this option is focused. Use for mockups, code snippets, diagrams, or concrete comparisons. Previews are supported only for single-select questions.',
  ),
}).strict()

const questionSchema = z.object({
  question: z.string().min(1).describe(
    'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  ),
  header: z.string().min(1).max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH).describe(
    `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
  ),
  options: z.array(questionOptionSchema).min(2).max(4).describe(
    "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
  ),
  multiSelect: z.boolean().optional().default(false).describe(
    'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
  ),
}).strict()

const annotationsSchema = z.record(z.string(), z.object({
  preview: z.string().optional(),
  notes: z.string().optional(),
}).strict()).optional()

const askUserQuestionInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).describe('Questions to ask the user (1-4 questions)'),
  answers: z.record(z.string(), z.string()).optional().describe('User answers collected by the UI; models should omit this field.'),
  annotations: annotationsSchema.describe('Optional per-question preview/notes annotations collected by the UI; models should omit this field.'),
}).strict().refine((data) => {
  const questionTexts = data.questions.map((q) => q.question)
  if (questionTexts.length !== new Set(questionTexts).size) return false
  return data.questions.every((question) => {
    const labels = question.options.map((option) => option.label)
    return labels.length === new Set(labels).size
  })
}, {
  message: 'Question texts must be unique, option labels must be unique within each question',
}).refine((data) => data.questions.every((question) => {
  if (question.multiSelect !== true) return true
  return question.options.every((option) => !option.preview)
}), {
  message: 'Option previews are only supported for single-select questions',
})

/**
 * AskUserQuestion — multiple-choice clarification tool.
 *
 * Aligned with Claude Code's AskUserQuestionTool. Use during a turn to
 * resolve genuine ambiguity (architectural choices, missing requirements,
 * preferences) BEFORE producing the final result. Particularly important
 * during plan mode, where it pairs with ExitPlanMode as the only two
 * legitimate ways to end a turn.
 *
 * Sub-agent isolation: this is a main-thread tool. Sub-agents see the
 * tool removed from their toolset (via ALL_AGENT_DISALLOWED_TOOLS).
 * The execute path also guards on `askUserQuestionBridge` presence.
 */
export const askUserQuestionTool: Tool = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: buildAskUserQuestionDescription(),
  inputSchema: askUserQuestionInputSchema,
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: false,
  userFacingName: () => 'Ask',
  getToolUseSummary(input) {
    const questions = typeof input === 'object' && input !== null
      ? (input as { questions?: unknown }).questions
      : undefined
    if (!Array.isArray(questions)) return null
    const firstHeader = questions
      .map((question) => typeof question === 'object' && question !== null ? (question as { header?: unknown }).header : undefined)
      .find((header): header is string => typeof header === 'string' && header.trim().length > 0)
    return firstHeader ?? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`
  },
  getActivityDescription: () => 'Asking user',
  async execute(input, context) {
    const parsed = askUserQuestionInputSchema.parse(input)

    if (!context.askUserQuestionBridge) {
      return {
        ok: false,
        content: 'AskUserQuestion is unavailable in this runtime (no UI bridge wired).',
        errorCode: 'precondition_failed',
      }
    }

    // Sub-agent guard: agentTool.filterToolsForSubAgent already removes
    // this tool from sub-agent toolsets, but if a custom agent definition
    // smuggles it through we still refuse.
    if (context.planModeBridge && context.planModeBridge.parentSessionId !== context.sessionId) {
      return {
        ok: false,
        content: 'AskUserQuestion is a main-thread tool. Sub-agents must summarize findings instead of asking the user directly.',
        errorCode: 'precondition_failed',
      }
    }

    const questions = parsed.questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options.map((option) => ({
        label: option.label,
        description: option.description,
        ...(option.preview ? { preview: option.preview } : {}),
      })),
      multiSelect: q.multiSelect ?? false,
    }))

    const result = await context.askUserQuestionBridge.ask({ questions })

    if (result.kind === 'rejected') {
      const fb = result.feedback?.trim()
      const tail = fb && fb.length > 0 ? ` Feedback: ${fb}` : ''
      return {
        ok: false,
        content: `User declined to answer the questions.${tail}`,
        errorCode: 'permission_denied',
      }
    }

    const answersText = Object.entries(result.answers)
      .map(([q, a]) => {
        const annotation = result.annotations?.[q]
        const parts = [`"${q}"="${a}"`]
        if (annotation?.preview) parts.push(`selected preview:\n${annotation.preview}`)
        if (annotation?.notes) parts.push(`user notes: ${annotation.notes}`)
        return parts.join(' ')
      })
      .join(', ')

    return {
      ok: true,
      content: `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers: result.answers,
        annotations: result.annotations,
        display: {
          summary: `Answered ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`,
          answers: result.answers,
        },
      },
    }
  },
}
