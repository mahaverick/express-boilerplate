/**
 * @file Users, staff and bearer tokens for the /platform/users tests. Every
 * user made here is tracked; call `deleteTrackedUsers` in an afterEach
 * (after `truncateAuditLogs`, whose rows reference users).
 */
import { randomUUID } from 'node:crypto'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { makeStaff } from './platform-staff'

const userRepository = new UserRepository()
const trackedUserIds: string[] = []

/**
 * The password every `hasPassword: true` test user has.
 */
export const TEST_PASSWORD = 'correct-horse-battery-9'

/**
 * How `createTrackedUser` builds its row. Defaults: a random address, no
 * names, no password, verified, active.
 */
export interface TestUserOptions {
  email?: string
  firstName?: string | null
  lastName?: string | null
  hasPassword?: boolean
  verified?: boolean
  active?: boolean
}

/**
 * Insert a user directly and track it for cleanup.
 * @param options - How to build the row.
 * @returns The inserted user.
 */
export async function createTrackedUser(options: TestUserOptions = {}): Promise<User> {
  const user = await userRepository.create({
    email: options.email ?? `pu-${randomUUID()}@example.test`,
    // eslint-disable-next-line unicorn/no-null -- the column is nullable; null is "no name"
    firstName: options.firstName ?? null,
    // eslint-disable-next-line unicorn/no-null -- as above
    lastName: options.lastName ?? null,
    // eslint-disable-next-line unicorn/no-null -- a passwordless account
    passwordHash: options.hasPassword === true ? await hashPassword(TEST_PASSWORD) : null,
    // eslint-disable-next-line unicorn/no-null -- an unverified account
    emailVerifiedAt: options.verified === false ? null : new Date(),
    active: options.active ?? true,
  })
  trackedUserIds.push(user.id)
  return user
}

/**
 * A bearer token for `user` on a random session id (no refresh row).
 * @param user - The user.
 * @returns A signed access token.
 */
export function tokenFor(user: User): string {
  return signAccessToken(user, randomUUID())
}

/**
 * A bearer token that passes the step-up check: `auth_time` is now.
 * @param user - The user.
 * @returns A signed access token.
 */
export function recentAuthTokenFor(user: User): string {
  return signAccessToken(user, randomUUID(), new Date())
}

/**
 * A bearer token with no `auth_time`, which the step-up check treats as stale.
 * @param user - The user.
 * @returns A signed access token.
 */
export function staleAuthTokenFor(user: User): string {
  return signAccessToken(user, randomUUID())
}

/**
 * A tracked user holding `role` in the platform tenant, with a token that
 * passes the step-up check (stale cases ask for `staleAuthTokenFor`).
 * @param role - The platform role.
 * @param options - How to build the user row.
 * @returns The user and a bearer token for them.
 */
export async function createTrackedStaff(
  role: MembershipRole,
  options: TestUserOptions = {}
): Promise<{ user: User; token: string }> {
  const user = await createTrackedUser(options)
  await makeStaff(user.id, role)
  return { user, token: recentAuthTokenFor(user) }
}

/**
 * Hard-delete every tracked user (memberships and tokens cascade).
 * @returns Resolves once the rows are gone.
 */
export async function deleteTrackedUsers(): Promise<void> {
  if (trackedUserIds.length === 0) return
  await sql`delete from users where id = any(${trackedUserIds})`
  trackedUserIds.length = 0
}
