/**
 * @file Mail sent to an address before it had an account joins that account
 * when the account is created, so a staff member's Emails list for the user
 * shows the invitation that brought them in. Every creation path adopts it:
 * a sign-in link's first click, a one-click invitation, an invitation
 * confirm link, a Google sign-up, a staff-created account and
 * `platform:grant`. Mail from before an earlier, soft-deleted holder of the
 * address left stays unowned, and mail another account owns is never moved.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { Tenant } from '@/database/models/tenant.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, sql } from '@/services/database.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { issueLinkToken } from '@/services/link-token.service'
import { createUser as createPlatformUser } from '@/services/platform-user.service'
import { bootstrapGrant } from '@/services/platform.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { verifySignInLink } from '@/services/sign-in-link.service'
import { verifyInvitation } from '@/services/tenant-invitation.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedMessage, deleteTrackedEmailRows } from '../../helpers/email-messages'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { issueTestLink } from '../../helpers/sign-in'

const app = createApp()
const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const usedEmails: string[] = []
const createdTenantIds: string[] = []

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `adopt-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * A `tenant_invitation` message to an address that had no account when it was sent.
 * @param recipient - The address.
 * @param createdAt - When it was sent; now by default.
 * @returns The message's id.
 */
async function unownedInvitationMail(recipient: string, createdAt = new Date()): Promise<string> {
  const message = await createTrackedMessage({
    recipient,
    templateKey: 'tenant_invitation',
    // eslint-disable-next-line unicorn/no-null -- the column's "no account"
    userId: null,
    createdAt,
  })
  return message.id
}

/**
 * The account a message belongs to.
 * @param id - The message.
 * @returns Its `user_id`, or null.
 */
async function ownerOf(id: string): Promise<string | null> {
  const [row] = await sql<{ userId: string | null }[]>`
    select user_id as "userId" from email_messages where id = ${id}
  `
  if (!row) throw new Error(`message ${id} is gone`)
  return row.userId
}

/**
 * The id of the live account holding an address.
 * @param email - The address.
 * @returns The user's id.
 */
async function accountIdOf(email: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from users where lower(email) = ${email} and deleted_at is null
  `
  if (!row) throw new Error(`no account holds ${email}`)
  return row.id
}

/**
 * A customer tenant owned by a fresh user, tracked for cleanup.
 * @returns The tenant.
 */
async function customerTenant(): Promise<Tenant> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `adopt-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return tenant
}

/**
 * Write a pending invitation with a known raw token.
 * @param tenant - The tenant it invites to.
 * @param email - The invited address.
 * @returns The raw token and the invitation's id.
 */
async function seedInvitation(
  tenant: Tenant,
  email: string
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const inviter = await createTrackedUser()
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'viewer',
        tokenHash: hashToken(rawToken),
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * A Google profile that reports `email` as verified.
 * @param email - The address.
 * @returns The profile `completeGoogleSignIn` receives.
 */
function googleProfile(email: string): GoogleProfile {
  const id = randomUUID()
  return {
    provider: 'google',
    id,
    displayName: 'Probe User',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: 0,
      exp: 0,
      email,
      email_verified: true,
    },
  }
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedEmailRows()
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from tenant_invitations where email = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

describe('mail sent before the account existed', () => {
  it('joins the account a sign-in link creates', async () => {
    const email = uniqueEmail('link')
    const messageId = await unownedInvitationMail(email)

    const session = await verifySignInLink(await issueTestLink(email))

    expect(await ownerOf(messageId)).toBe(session.user.id)
  })

  it('joins the account a one-click customer invitation creates', async () => {
    const email = uniqueEmail('one-click')
    const messageId = await unownedInvitationMail(email)
    const { rawToken } = await seedInvitation(await customerTenant(), email)

    const outcome = await verifyInvitation(rawToken)

    if (outcome.kind !== 'session') throw new Error('a new customer invitee joins in one click')
    expect(await ownerOf(messageId)).toBe(outcome.session.user.id)
  })

  it('joins the account a staff invitation confirm link creates', async () => {
    const email = uniqueEmail('confirm')
    const messageId = await unownedInvitationMail(email)
    const { invitationId } = await seedInvitation(await platformTenant(), email)
    const { raw } = await issueLinkToken(
      { intent: 'invitation', email, app: 'apex', invitationId },
      requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
    )

    const response = await request(app)
      .post('/api/v1/invitations/confirm')
      .send({ token: raw, email })

    expect(response.status).toBe(200)
    expect(await ownerOf(messageId)).toBe(await accountIdOf(email))
  })

  it('joins the account a Google sign-up creates', async () => {
    const email = uniqueEmail('google')
    const messageId = await unownedInvitationMail(email)

    await completeGoogleSignIn(googleProfile(email), 'web')

    expect(await ownerOf(messageId)).toBe(await accountIdOf(email))
  })

  it('joins the account a staff member creates', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const email = uniqueEmail('staff-created')
    const messageId = await unownedInvitationMail(email)

    const { user } = await createPlatformUser({ userId: admin.id }, { email })

    expect(await ownerOf(messageId)).toBe(user.id)
  })

  it('joins the account platform:grant creates', async () => {
    const email = uniqueEmail('grant')
    const messageId = await unownedInvitationMail(email)

    const membership = await bootstrapGrant(email, 'viewer')

    expect(await ownerOf(messageId)).toBe(membership.userId)
    await sql`delete from user_memberships where id = ${membership.id}`
  })

  it("shows on the staff Emails list for the new user, which said 'No emails sent' before", async () => {
    const { token } = await createTrackedStaff('viewer')
    const email = uniqueEmail('listed')
    const messageId = await unownedInvitationMail(email)

    const session = await verifySignInLink(await issueTestLink(email))
    const response = await request(app)
      .get(`/api/v1/platform/emails?user=${session.user.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    const ids = (response.body as { data: { items: { id: string }[] } }).data.items.map(
      (item) => item.id
    )
    expect(ids).toEqual([messageId])
  })

  it('leaves mail from before an earlier holder of the address left unowned', async () => {
    const email = uniqueEmail('earlier-holder')
    const beforeEarlier = await unownedInvitationMail(email, new Date(Date.now() - 60_000))
    const earlier = await createTrackedUser({ email })
    const earlierMessage = await createTrackedMessage({ recipient: email, userId: earlier.id })
    const ownedByEarlier = earlierMessage.id
    await sql`update users set deleted_at = now() where id = ${earlier.id}`
    const afterEarlier = await unownedInvitationMail(email, new Date(Date.now() + 1000))

    const session = await verifySignInLink(await issueTestLink(email))

    expect(await ownerOf(beforeEarlier)).toBeNull()
    expect(await ownerOf(ownedByEarlier)).toBe(earlier.id)
    expect(await ownerOf(afterEarlier)).toBe(session.user.id)
  })

  it("never moves another address's unowned mail", async () => {
    const email = uniqueEmail('mine')
    const other = uniqueEmail('other')
    const othersMessage = await unownedInvitationMail(other)

    await verifySignInLink(await issueTestLink(email))

    expect(await ownerOf(othersMessage)).toBeNull()
  })
})
