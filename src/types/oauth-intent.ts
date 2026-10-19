/**
 * @file What a Google round-trip is for, kept in its OAuth express-session
 * from `/auth/google` to the callback.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

/**
 * A Google sign-in to one frontend, with the same-origin path to land on
 * after it, when the start named a valid one.
 */
export type OAuthIntent = { kind: 'sign_in'; app: FrontendApp; redirect?: string }
