/**
 * @file A session with a grace-window sibling: the chain's head after one
 * rotation, plus the second live chain a replay of the rotated token mints
 * within REFRESH_REUSE_GRACE_MS. Both share one session id.
 */
import { randomUUID } from 'node:crypto'
import type { User } from '@/database/models/user.model'
import { sql } from '@/services/database.service'
import {
  hashToken,
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { testRefreshCookie } from './refresh-cookie'

/**
 * One session holding two live refresh chains, and a bearer on that session.
 * `spent` is the session's first token: rotated, so revoked, and replayed once.
 */
export interface SessionWithSibling {
  spent: string
  head: IssuedRefreshToken
  sibling: IssuedRefreshToken
  bearer: string
}

/**
 * Sign `user` in, rotate once, and replay the rotated token at once, so the
 * replay lands inside the grace window and mints a sibling.
 * @param user - The session's user.
 * @returns The spent first token, the caller's head, the sibling, and a bearer carrying their shared `sid`.
 */
export async function sessionWithSibling(user: User): Promise<SessionWithSibling> {
  const first = await issueRefreshToken(user.id, randomUUID())
  const head = await rotateRefreshToken(first.raw)
  const sibling = await rotateRefreshToken(first.raw)
  if (sibling.sessionId !== head.sessionId || sibling.raw === head.raw) {
    throw new Error('sessionWithSibling: the replay did not mint a sibling')
  }
  return { spent: first.raw, head, sibling, bearer: signAccessToken(user, head.sessionId) }
}

/**
 * The `Cookie` header value a browser sends with `raw` as its refresh cookie.
 * @param raw - A raw refresh token.
 * @returns `name=value` under the suite's cookie name.
 */
export function refreshCookieHeader(raw: string): string {
  return `${testRefreshCookie().name}=${encodeURIComponent(raw)}`
}

/**
 * Rotate a refresh token and report the session the new one continues.
 * @param raw - The raw refresh token to rotate.
 * @returns The new token's session id; rejects as the rotation does.
 */
export async function rotatedSessionId(raw: string): Promise<string> {
  const rotated = await rotateRefreshToken(raw)
  return rotated.sessionId
}

/**
 * Whether a token's row is still unrevoked, read without rotating it.
 * @param raw - The raw token.
 * @returns True when its row exists and is not revoked.
 */
export async function isTokenRowLive(raw: string): Promise<boolean> {
  const rows = await sql<{ revoked_at: string | null }[]>`
    select revoked_at from user_tokens where token_hash = ${hashToken(raw)}
  `
  return rows.length === 1 && rows[0]?.revoked_at === null
}
