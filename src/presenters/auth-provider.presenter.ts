// src/presenters/auth-provider.presenter.ts
//
// `providerId` is deliberately absent from the public shape: it holds the
// caller's email for 'email' and Google's stable `sub` for 'google', an
// external identifier with no reason to leave this server.
import type { AuthProvider } from '@/constants/auth-provider.constants'
import type { AuthProviderRecord } from '@/database/models/auth-provider.model'

/**
 * One `auth_providers` row as the API exposes it; `linkedAt` is its `createdAt`.
 */
export interface PublicAuthProvider {
  provider: AuthProvider
  linkedAt: Date
}

/**
 * Project and order a user's provider rows for the client.
 *
 * Sorted here: Postgres guarantees no order without ORDER BY, and
 * `findByUser`'s other callers do not need one.
 * @param rows - The user's provider rows, in any order.
 * @returns `{ provider, linkedAt }` per row, oldest link first.
 */
export function toPublicAuthProviders(rows: readonly AuthProviderRecord[]): PublicAuthProvider[] {
  return rows
    .toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((row) => ({ provider: row.provider, linkedAt: row.createdAt }))
}
