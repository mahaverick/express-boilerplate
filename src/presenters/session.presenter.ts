/**
 * @file Live sessions to their wire shape. The session id goes out, since the
 * caller's own access token already carries it as `sid`.
 */
import type { ClientKind } from '@/constants/native-client.constants'
import type { LiveSession } from '@/repositories/user-token.repository'

/**
 * One signed-in session as the API exposes it. `current` is true for the
 * session the request's access token belongs to.
 */
export interface SessionResponse {
  id: string
  client: ClientKind
  deviceName: string | null
  createdAt: string
  lastUsedAt: string
  current: boolean
}

/**
 * Project a live session for the client.
 * @param session - The session read from the repository.
 * @param currentSessionId - The `sid` of the caller's access token, if it has one.
 * @returns The public shape, with ISO timestamps.
 */
export function toSessionResponse(
  session: LiveSession,
  currentSessionId: string | undefined
): SessionResponse {
  return {
    id: session.sessionId,
    client: session.client,
    deviceName: session.deviceName,
    createdAt: session.startedAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    current: session.sessionId === currentSessionId,
  }
}
