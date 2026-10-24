/**
 * The window's one unsent new session.
 *
 * A fresh session is invisible in the sidebar until it has a conversation, so
 * the user cannot get back to it by clicking. Instead every「新会话」returns to
 * it, and the project it belongs to is whichever `+` was clicked last: picking
 * another project moves the typed prompt to a new session there.
 */

export interface DraftCandidate {
  readonly lane: string
  readonly projectRoot: string
  readonly hasConversation: boolean
  /** Coordinator and thread sessions are never the user's draft. */
  readonly coordinated: boolean
  readonly lastActiveTick: number
}

/** The draft lane: the active pane when it is one, else the most recently used. */
export function findDraft(
  candidates: readonly DraftCandidate[],
  activeLane: string | undefined,
): DraftCandidate | undefined {
  const drafts = candidates.filter((candidate) => !candidate.hasConversation && !candidate.coordinated)
  return (
    drafts.find((candidate) => candidate.lane === activeLane) ??
    drafts.sort((a, b) => b.lastActiveTick - a.lastActiveTick)[0]
  )
}

export type NewSessionPlan =
  | { readonly kind: 'reuse'; readonly lane: string }
  /** `carryFrom` is the draft whose text moves to the opened session before it is closed. */
  | { readonly kind: 'open'; readonly carryFrom?: string }

/** `target` is the project the new session is for; undefined when there is none to name. */
export function planNewSession(target: string | undefined, draft: DraftCandidate | undefined): NewSessionPlan {
  if (draft === undefined) return { kind: 'open' }
  if (target === undefined || target === draft.projectRoot) return { kind: 'reuse', lane: draft.lane }
  return { kind: 'open', carryFrom: draft.lane }
}
