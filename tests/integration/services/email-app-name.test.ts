/**
 * @file Every mail names the product its link opens: `APEX_APP_NAME` for a
 * link into Apex (a staff sign-in or welcome, a step-up, a staff invitation
 * and its confirm link), `APP_NAME` for one into the customer app. The name
 * is read from the queued job's variables, which are what the template
 * renders and what `email_messages` stores.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { addEmailJob, type EmailJobData } from '@/jobs/email.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, sql } from '@/services/database.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { sendSignInLink } from '@/services/sign-in-link.service'
import { requestStepUpLink } from '@/services/step-up.service'
import { invite, verifyInvitation } from '@/services/tenant-invitation.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

vi.mock('@/jobs/email.job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/email.job')>()
  return { ...actual, addEmailJob: vi.fn(actual.addEmailJob) }
})

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
  const email = `app-name-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * The `appName` of the one mail queued for an address.
 * @param to - The recipient.
 * @returns The queued `appName`.
 */
function queuedAppName(to: string): unknown {
  const calls = vi
    .mocked(addEmailJob)
    .mock.calls.map(([data]) => data as EmailJobData)
    .filter((data) => data.to === to)
  expect(calls).toHaveLength(1)
  return (calls[0]?.variables as Record<string, unknown> | undefined)?.appName
}

/**
 * A customer tenant owned by a fresh user, tracked for cleanup.
 * @returns The tenant and its owner.
 */
async function customerTenant(): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser({ firstName: 'Ada', lastName: 'Lovelace' })
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `app-name-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * Write a pending invitation with a known raw token, bypassing the API.
 * @param tenant - The tenant it invites to.
 * @param inviter - Who sent it.
 * @param email - The invited address.
 * @returns The raw token.
 */
async function seedInvitation(tenant: Tenant, inviter: User, email: string): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url')
  await db.transaction((tx) =>
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
  return rawToken
}

/**
 * Click an invitation link and run the confirm mail's follow-up.
 * @param rawToken - The raw invitation token.
 */
async function verifyAndFollowUp(rawToken: string): Promise<void> {
  const outcome = await verifyInvitation(rawToken)
  if (outcome.kind !== 'confirm') throw new Error('expected the confirm branch')
  await outcome.followUp()
}

beforeEach(() => {
  vi.mocked(addEmailJob).mockClear()
})

afterEach(async () => {
  if (usedEmails.length > 0) {
    await sql`delete from tenant_invitations where email = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from email_messages where recipient = any(${usedEmails})`
  }
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
  usedEmails.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

describe('the product name each mail carries', () => {
  const { APP_NAME, APEX_APP_NAME } = getEnv()

  it('defaults to two different names, so the cases below tell them apart', () => {
    expect(APP_NAME).toBe('Express Boilerplate')
    expect(APEX_APP_NAME).toBe('Apex')
  })

  it.each([
    { app: 'web', reason: 'self', expected: 'Express Boilerplate' },
    { app: 'apex', reason: 'self', expected: 'Apex' },
    { app: 'web', reason: 'welcome', expected: 'Express Boilerplate' },
    { app: 'apex', reason: 'welcome', expected: 'Apex' },
    { app: 'apex', reason: 'staff', expected: 'Apex' },
  ] as const)(
    'names $expected on a $reason sign-in link into $app',
    async ({ app, reason, expected }) => {
      const email = uniqueEmail(`${app}-${reason}`)

      await sendSignInLink({ email, app, reason })

      expect(queuedAppName(email)).toBe(expected)
    }
  )

  it('names Apex on a step-up link', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('step-up') })
    await makeStaff(user.id, 'admin')

    await requestStepUpLink(user.id, randomUUID(), 'apex')

    expect(queuedAppName(user.email)).toBe('Apex')
  })

  it('names Apex on a staff invitation and the customer app on a customer one', async () => {
    const platform = await platformTenant()
    const staffOwner = await createTrackedUser()
    await makeStaff(staffOwner.id, 'owner')
    const { tenant, owner } = await customerTenant()
    const staffInvitee = uniqueEmail('staff-invite')
    const customerInvitee = uniqueEmail('customer-invite')

    await invite({ userId: staffOwner.id }, platform.id, staffInvitee, 'viewer')
    await invite({ userId: owner.id }, tenant.id, customerInvitee, 'viewer')

    expect(queuedAppName(staffInvitee)).toBe('Apex')
    expect(queuedAppName(customerInvitee)).toBe('Express Boilerplate')
  })

  it('names Apex on a staff confirm link and the customer app on a customer one', async () => {
    const platform = await platformTenant()
    const { tenant, owner } = await customerTenant()
    const staffInvitee = uniqueEmail('staff-confirm')
    const customerInvitee = await createTrackedUser({ email: uniqueEmail('customer-confirm') })

    await verifyAndFollowUp(await seedInvitation(platform, owner, staffInvitee))
    await verifyAndFollowUp(await seedInvitation(tenant, owner, customerInvitee.email))

    expect(queuedAppName(staffInvitee)).toBe('Apex')
    expect(queuedAppName(customerInvitee.email)).toBe('Express Boilerplate')
  })
})
