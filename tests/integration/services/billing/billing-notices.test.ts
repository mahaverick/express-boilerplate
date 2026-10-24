/**
 * @file The billing notices a member or staff action sends after its
 * transaction: the trial's start, on creation and on a staff-made
 * workspace's first owner join; a join a full workspace refused, which tells
 * the owners once a day and leaves nothing written; and the payer's leaving
 * while a subscription runs, which tells the owners who remain. No worker
 * runs: the test reads the `email_messages` rows and the queued notification
 * jobs, and runs a notification job through its processor by hand.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { getEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { initialBillingFor } from '@/services/billing/trial.service'
import { db, sql, withTransaction } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { deleteUser } from '@/services/platform-user.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { accept, confirmInvitation, verifyInvitation } from '@/services/tenant-invitation.service'
import { leaveTenant, removeMember } from '@/services/tenant-membership.service'
import { createTenant } from '@/services/tenant.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { processNotificationJob } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  plans,
  billingColumn,
  readBilling,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  return fakeProviderModule()
})

const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Workspaces this file made outside the billing helper.
 */
const ownTenantIds: string[] = []

/**
 * Addresses whose accounts a one-click join created.
 */
const usedEmails: string[] = []

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  if (ownTenantIds.length > 0) await sql`delete from tenants where id = any(${ownTenantIds})`
  ownTenantIds.length = 0
  if (usedEmails.length > 0) {
    await sql`delete from notifications where user_id in (select id from users where email = any(${usedEmails}))`
    await sql`delete from users where email = any(${usedEmails})`
  }
  usedEmails.length = 0
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * An address no row holds yet, removed with any account made for it.
 * @returns The address.
 */
function freshEmail(): string {
  const email = `notices-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * One workspace's mail of one template.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns Each message's recipient and stored variables.
 */
async function mailsOf(
  tenantId: string,
  templateKey: string
): Promise<{ recipient: string; variables: Record<string, string> }[]> {
  return [
    ...(await sql<{ recipient: string; variables: Record<string, string> }[]>`
      select recipient, variables from email_messages
      where tenant_id = ${tenantId} and template_key = ${templateKey}
      order by recipient`),
  ]
}

/**
 * The queued notification jobs for one workspace.
 * @param tenantId - The workspace.
 * @returns The jobs.
 */
async function noticeJobsOf(tenantId: string) {
  const jobs = await queuedJobs<NotificationJobData>(getNotificationQueue())
  return jobs.filter(
    (job) => (job.data.metadata as { tenantId?: string } | undefined)?.tenantId === tenantId
  )
}

/**
 * The in-app notifications of one type for some users.
 * @param userIds - The users.
 * @param type - The notification type.
 * @returns Each row's user.
 */
async function inAppOf(userIds: string[], type: string): Promise<string[]> {
  const rows = await sql<
    { userId: string }[]
  >`select user_id as "userId" from notifications where user_id = any(${userIds}) and type = ${type}`
  return rows.map((row) => row.userId).toSorted()
}

/**
 * A staff-made workspace with no owner, waiting for its first owner's trial.
 * @returns The workspace.
 */
async function ownerlessWorkspace(): Promise<Tenant> {
  const tenant = await withTransaction(async (tx) =>
    tenantRepository.createWithoutOwner(
      { name: 'Staff Made', slug: `notices-staff-${randomUUID()}` },
      tx,
      await initialBillingFor(null, tx)
    )
  )
  ownTenantIds.push(tenant.id)
  return tenant
}

/**
 * Write a pending invitation with a known raw token.
 * @param tenant - The workspace.
 * @param options - The address, role and inviter.
 * @param options.email - The invited address.
 * @param options.role - The role it grants.
 * @param options.invitedBy - Who sent it.
 * @returns The raw token and the invitation id.
 */
async function seedInvitation(
  tenant: Tenant,
  options: { email: string; role?: MembershipRole; invitedBy: string }
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email: options.email,
        role: options.role ?? 'viewer',
        tokenHash: hashToken(rawToken),
        invitedBy: options.invitedBy,
        expiresAt: new Date(Date.now() + DAY_MS),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * Add members to a workspace.
 * @param tenantId - The workspace.
 * @param role - Their role.
 * @param count - How many.
 * @returns The new members.
 */
async function addMembers(tenantId: string, role: MembershipRole, count: number): Promise<User[]> {
  const added: User[] = []
  for (let index = 0; index < count; index += 1) {
    const member = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenantId}, ${role})`
    added.push(member)
  }
  return added
}

describe('the trial started email', () => {
  it('mails the owner when a workspace is created with a trial, and not for their second', async () => {
    const owner = await createTrackedUser()

    const first = await createTenant(
      { userId: owner.id },
      { name: 'Trial Co', slug: `notices-${randomUUID()}` }
    )
    ownTenantIds.push(first.id)
    const second = await createTenant(
      { userId: owner.id },
      { name: 'Second Co', slug: `notices-${randomUUID()}` }
    )
    ownTenantIds.push(second.id)

    const mails = await mailsOf(first.id, 'trial_started')
    expect(mails.map((mail) => mail.recipient)).toStrictEqual([owner.email])
    const row = await readBilling(first.id)
    expect(row.trialEndsAt).not.toBeNull()
    expect(mails[0]?.variables).toMatchObject({ tenantName: 'Trial Co' })
    expect(await mailsOf(second.id, 'trial_started')).toStrictEqual([])
  })

  it('mails the first owner of a staff-made workspace once when they accept', async () => {
    const tenant = await ownerlessWorkspace()
    const { user: staff } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenant, {
      email: invitee.email,
      role: 'owner',
      invitedBy: staff.id,
    })

    await accept(rawToken, invitee.id)
    await accept(rawToken, invitee.id)

    expect(await billingColumn(tenant.id, 'state')).toBe('trialing')
    const mails = await mailsOf(tenant.id, 'trial_started')
    expect(mails.map((mail) => mail.recipient)).toStrictEqual([invitee.email])
  })

  it('mails the first owner of a staff-made workspace when they join by one click', async () => {
    const tenant = await ownerlessWorkspace()
    const { user: staff } = await createTrackedStaff('admin')
    const email = freshEmail()
    const { rawToken } = await seedInvitation(tenant, { email, role: 'owner', invitedBy: staff.id })

    const outcome = await verifyInvitation(rawToken)

    expect(outcome.kind).toBe('session')
    const mails = await mailsOf(tenant.id, 'trial_started')
    expect(mails.map((mail) => mail.recipient)).toStrictEqual([email])
  })
})

describe('the trial started email by confirm link', () => {
  it('mails the first owner of a staff-made workspace when they confirm, once', async () => {
    const tenant = await ownerlessWorkspace()
    const { user: staff } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const { invitationId } = await seedInvitation(tenant, {
      email: invitee.email,
      role: 'owner',
      invitedBy: staff.id,
    })
    const { raw } = await issueLinkToken(
      { intent: 'invitation', email: invitee.email, app: 'web', invitationId },
      requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
    )

    await confirmInvitation(raw)

    expect(await billingColumn(tenant.id, 'state')).toBe('trialing')
    const mails = await mailsOf(tenant.id, 'trial_started')
    expect(mails.map((mail) => mail.recipient)).toStrictEqual([invitee.email])
  })
})

describe('the workspace full notice', () => {
  it('tells each owner once a day however many joins are refused, and writes nothing for the join', async () => {
    const { tenant, owner } = await workspace()
    const [coOwner] = await addMembers(tenant.id, 'owner', 1)
    if (coOwner === undefined) throw new Error('setup: no co-owner')
    await addMembers(tenant.id, 'viewer', 3)
    const invitees = [await createTrackedUser(), await createTrackedUser()]
    const tokens: string[] = []
    for (const invitee of invitees) {
      const { rawToken } = await seedInvitation(tenant, {
        email: invitee.email,
        invitedBy: owner.id,
      })
      tokens.push(rawToken)
    }
    const oneClick = await seedInvitation(tenant, { email: freshEmail(), invitedBy: owner.id })
    const before = await readBilling(tenant.id)

    for (const [index, invitee] of invitees.entries()) {
      await expect(accept(tokens[index] ?? '', invitee.id)).rejects.toMatchObject({
        statusCode: 402,
        code: 'PLAN_LIMIT_REACHED',
      })
    }
    await expect(verifyInvitation(oneClick.rawToken)).rejects.toMatchObject({ statusCode: 402 })

    // Nothing the refused joins began survives.
    const members = await sql`select 1 from user_memberships where tenant_id = ${tenant.id}`
    expect(members).toHaveLength(5)
    const accepted =
      await sql`select 1 from tenant_invitations where tenant_id = ${tenant.id} and accepted_at is not null`
    expect(accepted).toHaveLength(0)
    expect(await sql`select 1 from users where email = ${usedEmails[0] ?? ''}`).toHaveLength(0)
    expect(await billingColumn(tenant.id, 'version')).toBe(before.version)

    const jobs = await noticeJobsOf(tenant.id)
    expect(jobs.map((job) => job.data.userId).toSorted()).toStrictEqual(
      [owner.id, coOwner.id].toSorted()
    )
    for (const job of jobs) {
      expect(job.data.type).toBe('workspace_full')
      // The owners learn the count, never who tried to join.
      const text = `${job.data.title} ${job.data.body}`
      for (const invitee of invitees) expect(text).not.toContain(invitee.email)
      await processNotificationJob(job)
    }
    expect(await inAppOf([owner.id, coOwner.id], 'workspace_full')).toStrictEqual(
      [owner.id, coOwner.id].toSorted()
    )

    // A refusal later the same day adds nothing.
    await getNotificationQueue().obliterate({ force: true })
    await expect(accept(tokens[0] ?? '', invitees[0]?.id ?? '')).rejects.toMatchObject({
      statusCode: 402,
    })
    for (const job of await noticeJobsOf(tenant.id)) await processNotificationJob(job)
    expect(await inAppOf([owner.id, coOwner.id], 'workspace_full')).toHaveLength(2)
    await sql`delete from notifications where user_id = any(${[owner.id, coOwner.id]})`
  })
})

/**
 * A workspace paying on a live subscription, whose payer is `payer`.
 * @param tenantId - The workspace.
 * @param payer - The payer.
 */
async function payingBy(tenantId: string, payer: User): Promise<void> {
  await makePaying(tenantId)
  await setBilling(tenantId, { payerUserId: payer.id, billingEmail: payer.email })
}

/**
 * Check that one workspace's remaining owners, and only they, were told the
 * payer left, by a notification carrying the email.
 * @param tenantId - The workspace.
 * @param ownerIds - The owners who remain.
 */
async function expectPayerLeftTold(tenantId: string, ownerIds: string[]): Promise<void> {
  const jobs = await noticeJobsOf(tenantId)
  expect(jobs.map((job) => job.data.userId).toSorted()).toStrictEqual(ownerIds.toSorted())
  for (const job of jobs) {
    expect(job.data).toMatchObject({
      type: 'billing_payer_left',
      email: { templateKey: 'payer_left', variables: { payerName: 'Pat Payer' } },
    })
    // The payer's name is someone else's: it stays out of the stored notification.
    expect(`${job.data.title} ${job.data.body}`).not.toContain('Pat')
  }
  // The departed payer's own address is not mailed about the workspace.
  expect(await mailsOf(tenantId, 'payer_left')).toStrictEqual([])
  // The subscription keeps running.
  expect(await billingColumn(tenantId, 'state')).toBe('active')
}

describe('the payer left notice', () => {
  it('tells the remaining owners when the payer is removed', async () => {
    const { tenant, owner } = await workspace()
    const payer = await createTrackedUser({ firstName: 'Pat', lastName: 'Payer' })
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${payer.id}, ${tenant.id}, 'admin')`
    await payingBy(tenant.id, payer)

    await removeMember({ userId: owner.id }, tenant.id, payer.id)

    await expectPayerLeftTold(tenant.id, [owner.id])
  })

  it('tells the remaining owners when the payer leaves', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Pat' })
    await sql`update users set last_name = 'Payer' where id = ${owner.id}`
    const [coOwner] = await addMembers(tenant.id, 'owner', 1)
    await payingBy(tenant.id, owner)

    await leaveTenant({ userId: owner.id }, tenant.id)

    await expectPayerLeftTold(tenant.id, [coOwner?.id ?? ''])
  })

  it('tells the remaining owners of every workspace the payer paid for when staff delete them', async () => {
    const first = await workspace({ firstName: 'Pat' })
    const payer = first.owner
    await sql`update users set last_name = 'Payer' where id = ${payer.id}`
    const [firstCoOwner] = await addMembers(first.tenant.id, 'owner', 1)
    await payingBy(first.tenant.id, payer)
    const second = await workspace()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${payer.id}, ${second.tenant.id}, 'owner')`
    await payingBy(second.tenant.id, payer)
    const { user: staff } = await createTrackedStaff('admin')

    await deleteUser({ userId: staff.id }, payer.id, 'Asked to be deleted')

    await expectPayerLeftTold(first.tenant.id, [firstCoOwner?.id ?? ''])
    await expectPayerLeftTold(second.tenant.id, [second.owner.id])
  })

  it('gives the end of grace as the deadline when the payment has failed', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Pat' })
    await sql`update users set last_name = 'Payer' where id = ${owner.id}`
    const [coOwner] = await addMembers(tenant.id, 'owner', 1)
    await payingBy(tenant.id, owner)
    const haltedAt = new Date('2030-01-01T10:00:00.000Z')
    await setBilling(tenant.id, { state: 'past_due', pastDueSince: haltedAt, haltedAt })

    await leaveTenant({ userId: owner.id }, tenant.id)

    const [job] = await noticeJobsOf(tenant.id)
    expect(job?.data.userId).toBe(coOwner?.id)
    // Seven days' grace after the halt.
    expect(job?.data.email?.variables).toMatchObject({ periodEndsOn: '8 January 2030' })
    expect(job?.data.body).toContain('Add your card by 8 January 2030 to keep Paid.')
  })

  it('tells the owners once when a payer who already left is deleted', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Pat' })
    await sql`update users set last_name = 'Payer' where id = ${owner.id}`
    const [coOwner] = await addMembers(tenant.id, 'owner', 1)
    await payingBy(tenant.id, owner)
    await leaveTenant({ userId: owner.id }, tenant.id)
    await expectPayerLeftTold(tenant.id, [coOwner?.id ?? ''])
    // Emptied, so a second notice would show as a new job whatever its key.
    await getNotificationQueue().obliterate({ force: true })
    const { user: staff } = await createTrackedStaff('admin')

    await deleteUser({ userId: staff.id }, owner.id, 'Asked to be deleted')

    expect(await noticeJobsOf(tenant.id)).toStrictEqual([])
  })

  it('tells no one when the workspace has no live subscription', async () => {
    const { tenant, owner } = await workspace()
    const [coOwner] = await addMembers(tenant.id, 'owner', 1)
    // The payer of a subscription that has since ended.
    await setBilling(tenant.id, {
      state: 'free',
      planId: plans.freeId,
      payerUserId: owner.id,
      billingEmail: owner.email,
    })

    await leaveTenant({ userId: owner.id }, tenant.id)

    expect(await noticeJobsOf(tenant.id)).toStrictEqual([])
    expect(await mailsOf(tenant.id, 'payer_left')).toStrictEqual([])
    expect(coOwner).toBeDefined()
  })

  it('tells no one when a member who is not the payer leaves', async () => {
    const { tenant, owner } = await workspace()
    const [viewer] = await addMembers(tenant.id, 'viewer', 1)
    await payingBy(tenant.id, owner)

    await leaveTenant({ userId: viewer?.id ?? '' }, tenant.id)

    expect(await noticeJobsOf(tenant.id)).toStrictEqual([])
  })
})
