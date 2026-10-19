/**
 * @file A `sign_in_link` row names an address, not a user, so the
 * user-wide token revocations would miss it. Each path that ends every
 * session of a user also revokes the live sign-in links mailed to the
 * user's address, in the same transaction: signing out of the other
 * sessions, a staff sign-out and a deactivation. A revoked link then answers
 * `LINK_INVALID`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { LINK_INVALID_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { sql } from '@/services/database.service'
import { deactivateUser, signOutUser } from '@/services/platform-user.service'
import { hashToken, issueRefreshToken, revokeOtherSessions } from '@/services/session.service'
import { verifySignInLink } from '@/services/sign-in-link.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { issueTestLink } from '../../helpers/sign-in'

afterEach(async () => {
  await truncateAuditLogs()
  await sql`delete from user_tokens where purpose = 'sign_in_link' and email like 'link-revoke-%'`
  await deleteTrackedUsers()
})

/**
 * A user with a live sign-in link mailed to their address.
 * @returns The user and the link's raw token.
 */
async function userWithLiveLink(): Promise<{ user: User; raw: string }> {
  const user = await createTrackedUser({ email: `link-revoke-${randomUUID()}@example.test` })
  const raw = await issueTestLink(user.email)
  return { user, raw }
}

/**
 * Whether the link row for a raw token is revoked.
 * @param raw - The raw token.
 * @returns True once its `revoked_at` is set.
 */
async function isRevoked(raw: string): Promise<boolean> {
  const [row] = await sql<{ revoked: boolean }[]>`
    select revoked_at is not null as revoked from user_tokens where token_hash = ${hashToken(raw)}
  `
  if (!row) throw new Error('the link row is missing')
  return row.revoked
}

describe("revoking every session revokes the address's sign-in links", () => {
  it('signing out of the other sessions revokes them', async () => {
    const { user, raw } = await userWithLiveLink()
    const sessionId = randomUUID()
    await issueRefreshToken(user.id, sessionId)

    await revokeOtherSessions(user.id, sessionId)

    expect(await isRevoked(raw)).toBe(true)
    await expect(verifySignInLink(raw)).rejects.toMatchObject({ code: LINK_INVALID_CODE })
  })

  it('a staff sign-out revokes them', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const { user, raw } = await userWithLiveLink()

    await signOutUser({ userId: admin.id }, user.id, 'link revocation test')

    expect(await isRevoked(raw)).toBe(true)
    await expect(verifySignInLink(raw)).rejects.toMatchObject({ code: LINK_INVALID_CODE })
  })

  it('a deactivation revokes them', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const { user, raw } = await userWithLiveLink()

    await deactivateUser({ userId: admin.id }, user.id, 'link revocation test')

    expect(await isRevoked(raw)).toBe(true)
    await expect(verifySignInLink(raw)).rejects.toMatchObject({ code: LINK_INVALID_CODE })
  })

  it('leaves the links of another address alone', async () => {
    const { user } = await userWithLiveLink()
    const other = await userWithLiveLink()
    const sessionId = randomUUID()
    await issueRefreshToken(user.id, sessionId)

    await revokeOtherSessions(user.id, sessionId)

    expect(await isRevoked(other.raw)).toBe(false)
  })
})
