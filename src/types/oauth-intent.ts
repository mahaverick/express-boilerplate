/**
 * @file What a Google round-trip is for, kept in its OAuth express-session
 * from its start to the callback.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

/**
 * A Google sign-in to one frontend, with the same-origin path to land on
 * after it when the start named a valid one; or a staff step-up for one
 * signed-in session, started at `startedAt` (epoch milliseconds), which the
 * callback confirms without minting a session.
 */
export type OAuthIntent =
  | { kind: 'sign_in'; app: FrontendApp; redirect?: string }
  | { kind: 'step_up'; userId: string; sessionId: string; startedAt: number }

/**
 * A stored step-up intent the callback cannot use: one whose fields do not
 * check out. It is refused as a failed step-up, never read as a sign-in.
 */
export type InvalidStepUpIntent = { kind: 'invalid_step_up' }
