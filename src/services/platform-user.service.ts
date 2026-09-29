/**
 * @file Staff management of users, behind `/platform/users`. The routes check
 * the caller's platform role before any of this runs.
 */
import { AUTH_PROVIDERS, type AuthProvider } from '@/constants/auth-provider.constants'
import { HttpError } from '@/errors/http-error'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import {
  PlatformUserRepository,
  type PlatformUserCursor,
  type PlatformUserMembership,
  type PlatformUserPendingInvitation,
  type PlatformUserRecord,
} from '@/repositories/platform-user.repository'
import { UserRepository } from '@/repositories/user.repository'
import { encodeCursor } from '@/utilities/cursor.utilities'
import type { PlatformUserSearchQuery } from '@/validators/platform.validators'

const platformUserRepository = new PlatformUserRepository()
const authProviderRepository = new AuthProviderRepository()
const userRepository = new UserRepository()

/**
 * One user as the staff directory returns it.
 */
export type PlatformUserRow = PlatformUserRecord

/**
 * A page of users and the opaque cursors either side of it (null at each end).
 */
export interface PlatformUserPage {
  users: PlatformUserRow[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One user with everything the staff detail page shows.
 */
export interface PlatformUserDetail extends PlatformUserRow {
  hasPassword: boolean
  authProviders: AuthProvider[]
  memberships: PlatformUserMembership[]
  pendingInvitations: PlatformUserPendingInvitation[]
}

/**
 * Encode a cursor for the wire.
 * @param cursor - The decoded cursor, if any.
 * @returns The opaque string, or null at that end of the list.
 */
function encodeUserCursor(cursor: PlatformUserCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at each end of the list
  return cursor ? encodeCursor({ sortEmail: cursor.sortEmail, id: cursor.id }) : null
}

/**
 * Search users, one keyset page at a time, in either direction: live users,
 * or only soft-deleted ones under `status=deleted`.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page and both cursors.
 */
export async function searchUsers(query: PlatformUserSearchQuery): Promise<PlatformUserPage> {
  const page = await platformUserRepository.search({
    limit: query.limit,
    direction: query.direction,
    q: query.q,
    status: query.status,
    verified: query.verified,
    staff: query.staff,
    cursor: query.cursor,
  })
  return {
    users: page.users,
    nextCursor: encodeUserCursor(page.nextCursor),
    prevCursor: encodeUserCursor(page.prevCursor),
  }
}

/**
 * A user and everything the staff detail page shows. A soft-deleted user is
 * returned too, with `deletedAt` set: its page offers only a purge.
 * @param userId - The user's id.
 * @returns The detail.
 * @throws {HttpError} 404 when no user has that id.
 */
export async function getUserDetail(userId: string): Promise<PlatformUserDetail> {
  const record = await platformUserRepository.findRecord(userId, { includeDeleted: true })
  if (!record) throw new HttpError('User not found', 404)
  const [stored, providers, memberships, pendingInvitations] = await Promise.all([
    // includeDeleted: a soft-deleted user's page still says whether a password was set.
    userRepository.findById(userId, { includeDeleted: true }),
    authProviderRepository.findByUser(userId),
    platformUserRepository.listMemberships(userId),
    platformUserRepository.listPendingInvitations(record.email),
  ])
  const present = new Set(providers.map((provider) => provider.provider))
  return {
    ...record,
    hasPassword: stored?.passwordHash !== null && stored?.passwordHash !== undefined,
    authProviders: AUTH_PROVIDERS.filter((provider) => present.has(provider)),
    memberships,
    pendingInvitations,
  }
}
