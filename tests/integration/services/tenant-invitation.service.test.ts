// tests/integration/services/tenant-invitation.service.test.ts
//
// The invitation service against the real per-worker Postgres and Redis. No
// Worker runs here: enqueued jobs stay on the queues, where these tests read
// them. Queues are obliterated in afterAll.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import {
  accept,
  invite,
  listPending,
  preview,
  resend,
  revoke,
} from '@/services/tenant-invitation.service'
import { hashToken } from '@/utilities/token.utilities'
import { withMutatedMethod } from '../../helpers/mutate'
import { expectNoJob, waitForInvitationEmail, waitForJob } from '../../helpers/queue-jobs'

const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const HOUR_MS = 60 * 60 * 1000
const INVALID = { statusCode: 404, code: 'invitation_invalid' }
const MISMATCH = {
  statusCode: 403,
  code: 'invitation_email_mismatch',
  message: 'This invitation was sent to a different email address.',
}
const UNVERIFIED = {
  statusCode: 403,
  code: 'invitation_email_unverified',
  message: 'Verify your email address before accepting this invitation.',
}

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A disposable email, unique to one call.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `invitation-service-${randomUUID()}@example.test`
}

/**
 * A `resend` authorize callback that allows the resend, after checking that
 * the service handed it the pending row.
 * @param invitation - The pending invitation the service passes in.
 */
function allowPendingInvitation(invitation: TenantInvitation): void {
  expect(invitation.revokedAt).toBeNull()
}

/**
 * Write an invitation with a known raw token, bypassing `invite`.
 * @param tenant - The tenant.
 * @param invitedBy - The inviter.
 * @param options - Address, role and expiry.
 * @param options.email - The invited address.
 * @param options.role - The offered role. Defaults to editor.
 * @param options.expiresAt - The expiry. Defaults to an hour from now.
 * @returns The raw token and the stored row.
 */
async function seedInvitation(
  tenant: Tenant,
  invitedBy: User,
  options: { email: string; role?: MembershipRole; expiresAt?: Date }
): Promise<{ rawToken: string; invitation: TenantInvitation }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email: options.email,
        role: options.role ?? 'editor',
        tokenHash: hashToken(rawToken),
        invitedBy: invitedBy.id,
        expiresAt: options.expiresAt ?? new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return { rawToken, invitation }
}

/**
 * A `resend` authorize callback that refuses, naming the role it was handed.
 * @param pending - The pending invitation the service passes in.
 * @throws {HttpError} Always, 403.
 */
function refuseReissue(pending: TenantInvitation): void {
  throw new HttpError(`May not re-issue the ${pending.role} role`, 403)
}

/**
 * Run `run` while `findValidByTokenHash` answers with `stale`, as if accept
 * had read the row just before another transaction changed it. Records what
 * each `claimForAccept` returned, so a test can prove the claim was lost.
 * @param stale - The redeemable view captured earlier.
 * @param run - The accept to run.
 * @returns What each claim returned while `run` ran.
 */
async function withStaleRead(
  stale: Awaited<ReturnType<TenantInvitationRepository['findValidByTokenHash']>>,
  run: () => Promise<void>
): Promise<(TenantInvitation | undefined)[]> {
  const realClaim = invitationRepository.claimForAccept.bind(invitationRepository)
  const claims: (TenantInvitation | undefined)[] = []
  await withMutatedMethod(
    TenantInvitationRepository.prototype,
    'findValidByTokenHash',
    () => Promise.resolve(stale),
    () =>
      withMutatedMethod(
        TenantInvitationRepository.prototype,
        'claimForAccept',
        async (tokenHash, userId, executor) => {
          const claimed = await realClaim(tokenHash, userId, executor)
          claims.push(claimed)
          return claimed
        },
        run
      )
  )
  return claims
}

describe('tenant-invitation.service', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user, tracked for cleanup.
   * @param options - Whether the address is verified and the account active, and an explicit address.
   * @param options.verified - Set `emailVerifiedAt` to now. Defaults to true.
   * @param options.active - The account's `active` flag. Defaults to true.
   * @param options.email - The address. Defaults to a unique one.
   * @returns The created user.
   */
  async function createUser(
    options: { verified?: boolean; active?: boolean; email?: string } = {}
  ): Promise<User> {
    const user = await userRepository.create({
      email: options.email ?? uniqueEmail(),
      active: options.active ?? true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      ...(options.verified !== false && { emailVerifiedAt: new Date() }),
    })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * An owner and a tenant named Acme Inc they own, tracked for cleanup.
   * @returns The owner and the tenant.
   */
  async function setup(): Promise<{ owner: User; tenant: Tenant }> {
    const owner = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    return { owner, tenant }
  }

  describe('invite', () => {
    it('stores the address normalised and enqueues the invitation email', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()

      await invite(tenant.id, owner.id, `  ${email.toUpperCase()}  `, 'editor')

      const [pending] = await listPending(tenant.id)
      expect(pending).toMatchObject({ email, role: 'editor' })
      const queued = await waitForInvitationEmail(email)
      expect(queued.userId).toBe('')
      expect(queued.variables).toStrictEqual({
        tenantName: 'Acme Inc',
        inviterName: 'Ada Lovelace',
        role: 'editor',
        acceptUrl: `http://localhost:5173/invitations/accept?token=${queued.token}`,
        expiresInDays: '7',
        appName: queued.variables.appName,
      })
      expect(queued.token).toMatch(/^[\w-]{43}$/)
      const found = await invitationRepository.findValidByTokenHash(hashToken(queued.token))
      expect(found?.invitation.id).toBe(pending?.id)
    })

    it('answers already_member for a current member, whatever the case of the address', async () => {
      const { owner, tenant } = await setup()
      const member = await createUser()
      await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      await expect(
        invite(tenant.id, owner.id, member.email.toUpperCase(), 'editor')
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'already_member',
        message: 'That person is already a member.',
      })
      expect(await listPending(tenant.id)).toEqual([])
    })

    it('enqueues an in-app notification, carrying no token, for a verified existing user', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()

      await invite(tenant.id, owner.id, invitee.email, 'manager')

      const queued = await waitForInvitationEmail(invitee.email)
      expect(queued.userId).toBe(invitee.id)
      const [pending] = await listPending(tenant.id)
      const job = await waitForJob<NotificationJobData>(
        getNotificationQueue(),
        (data) => data.userId === invitee.id && data.type === 'tenant_invitation'
      )
      expect(job.data).toStrictEqual({
        userId: invitee.id,
        type: 'tenant_invitation',
        title: 'Invitation to Acme Inc',
        body: 'Ada Lovelace invited you to join as manager.',
        metadata: { tenantSlug: tenant.slug, invitationId: pending?.id },
      })
      expect(JSON.stringify(job.data)).not.toContain(queued.token)
    })

    it.each(['unverified', 'unregistered'] as const)(
      'enqueues no in-app notification for an %s address',
      async (kind) => {
        const { owner, tenant } = await setup()
        const unverified = kind === 'unverified' ? await createUser({ verified: false }) : undefined
        const email = unverified?.email ?? uniqueEmail()

        await invite(tenant.id, owner.id, email, 'viewer')

        await waitForInvitationEmail(email)
        const [pending] = await listPending(tenant.id)
        await expectNoJob<NotificationJobData>(
          getNotificationQueue(),
          (data) => data.type === 'tenant_invitation' && data.metadata?.invitationId === pending?.id
        )
      }
    )

    it('kills the earlier link when the same address is invited again', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      await invite(tenant.id, owner.id, email, 'viewer')
      const first = await waitForInvitationEmail(email)

      await invite(tenant.id, owner.id, email, 'editor')
      const second = await waitForInvitationEmail(email, [first.token])

      await expect(preview(first.token)).rejects.toMatchObject(INVALID)
      const secondPreview = await preview(second.token)
      expect(secondPreview.role).toBe('editor')
    })
  })

  describe('invite, account state', () => {
    it('enqueues no in-app notification for a verified but deactivated account', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser({ active: false })

      await invite(tenant.id, owner.id, invitee.email, 'viewer')

      await waitForInvitationEmail(invitee.email)
      const [pending] = await listPending(tenant.id)
      await expectNoJob<NotificationJobData>(
        getNotificationQueue(),
        (data) => data.type === 'tenant_invitation' && data.metadata?.invitationId === pending?.id
      )
    })

    it.each(['registered', 'unregistered'] as const)(
      'runs the membership lookup for an %s address too',
      async (kind) => {
        const { owner, tenant } = await setup()
        const registered = kind === 'registered' ? await createUser() : undefined
        const email = registered?.email ?? uniqueEmail()
        const original = userMembershipRepository.findByUserAndTenant.bind(userMembershipRepository)
        const lookups: string[] = []

        await withMutatedMethod(
          UserMembershipRepository.prototype,
          'findByUserAndTenant',
          (userId, tenantId, executor) => {
            lookups.push(tenantId)
            return original(userId, tenantId, executor)
          },
          () => invite(tenant.id, owner.id, email, 'viewer')
        )

        expect(lookups).toEqual([tenant.id])
      }
    )
  })

  describe('resend', () => {
    it('issues a new link and kills the old one', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      await invite(tenant.id, owner.id, email, 'viewer')
      const first = await waitForInvitationEmail(email)
      const [pending] = await listPending(tenant.id)

      await resend(tenant.id, pending?.id ?? '', owner.id, allowPendingInvitation)

      const second = await waitForInvitationEmail(email, [first.token])
      await expect(preview(first.token)).rejects.toMatchObject(INVALID)
      const secondPreview = await preview(second.token)
      expect(secondPreview.email).toBe(email)
    })

    it('answers invitation_not_found for a revoked invitation, or for another tenant', async () => {
      const { owner, tenant } = await setup()
      const { tenant: otherTenant } = await setup()
      const { invitation } = await seedInvitation(tenant, owner, { email: uniqueEmail() })
      const notFound = { statusCode: 404, code: 'invitation_not_found' }

      await expect(
        resend(otherTenant.id, invitation.id, owner.id, allowPendingInvitation)
      ).rejects.toMatchObject(notFound)
      await revoke(tenant.id, invitation.id)
      await expect(
        resend(tenant.id, invitation.id, owner.id, allowPendingInvitation)
      ).rejects.toMatchObject(notFound)
    })

    it('runs the caller’s check on the pending invitation first, and a refusal changes nothing', async () => {
      const { owner, tenant } = await setup()
      const { rawToken, invitation } = await seedInvitation(tenant, owner, {
        email: uniqueEmail(),
        role: 'owner',
      })
      await expect(resend(tenant.id, invitation.id, owner.id, refuseReissue)).rejects.toMatchObject(
        {
          statusCode: 403,
          message: 'May not re-issue the owner role',
        }
      )
      const unchanged = await preview(rawToken)
      expect(unchanged.role).toBe('owner')
    })
  })

  describe('resend, vanished tenant', () => {
    it('leaves the old link in place when the tenant is gone', async () => {
      const { owner, tenant } = await setup()
      const { rawToken, invitation } = await seedInvitation(tenant, owner, { email: uniqueEmail() })
      await tenantRepository.softDelete(tenant.id)

      await expect(
        resend(tenant.id, invitation.id, owner.id, allowPendingInvitation)
      ).rejects.toMatchObject({ statusCode: 404 })

      const [row] = await sql<{ tokenHash: string }[]>`
        select token_hash as "tokenHash" from tenant_invitations where id = ${invitation.id}
      `
      expect(row?.tokenHash).toBe(hashToken(rawToken))
    })
  })

  describe('revoke', () => {
    it('revokes once, then answers invitation_not_found', async () => {
      const { owner, tenant } = await setup()
      const { rawToken, invitation } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      await revoke(tenant.id, invitation.id)

      await expect(preview(rawToken)).rejects.toMatchObject(INVALID)
      await expect(revoke(tenant.id, invitation.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'invitation_not_found',
      })
    })
  })

  describe('preview', () => {
    it('returns the tenant, role, inviter and invited address', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      const { rawToken } = await seedInvitation(tenant, owner, { email })

      expect(await preview(rawToken)).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        invitedBy: { firstName: 'Ada', lastName: 'Lovelace' },
        email,
      })
    })

    it('answers invitation_invalid for an expired invitation', async () => {
      const { owner, tenant } = await setup()
      const { rawToken } = await seedInvitation(tenant, owner, {
        email: uniqueEmail(),
        expiresAt: new Date(Date.now() - 1000),
      })

      await expect(preview(rawToken)).rejects.toMatchObject({
        ...INVALID,
        message: 'This invitation is invalid or has expired.',
      })
    })
  })

  describe('accept', () => {
    it('makes the invitee a member with the invited role', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const accepted = await accept(rawToken, invitee.id)

      expect(accepted).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
      })
      const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      expect(membership?.role).toBe('editor')
      const found = await invitationRepository.findByTokenHash(hashToken(rawToken))
      expect(found?.invitation.acceptedBy).toBe(invitee.id)
    })

    it('lets the invitee accept an invite sent to their address in another case, with whitespace', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()

      await invite(tenant.id, owner.id, `  ${invitee.email.toUpperCase()}\t`, 'editor')
      const queued = await waitForInvitationEmail(invitee.email)

      const previewed = await preview(queued.token)
      expect(previewed.email).toBe(invitee.email)
      expect(await accept(queued.token, invitee.id)).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
      })
    })

    it('refuses an unverified account at the invited address as unverified, and claims nothing', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser({ verified: false })
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      await expect(accept(rawToken, invitee.id)).rejects.toMatchObject(UNVERIFIED)

      const unclaimed = await preview(rawToken)
      expect(unclaimed.email).toBe(invitee.email)
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
    })

    it('refuses a verified account with a different address', async () => {
      const { owner, tenant } = await setup()
      const stranger = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      await expect(accept(rawToken, stranger.id)).rejects.toMatchObject(MISMATCH)
    })

    it('refuses an unverified account with a different address as a mismatch', async () => {
      const { owner, tenant } = await setup()
      const stranger = await createUser({ verified: false })
      const { rawToken } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      await expect(accept(rawToken, stranger.id)).rejects.toMatchObject(MISMATCH)
    })

    it('succeeds again, idempotently, for the user who already accepted', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const first = await accept(rawToken, invitee.id)
      const second = await accept(rawToken, invitee.id)

      expect(second).toStrictEqual(first)
    })

    it('answers invitation_invalid to anyone else once accepted', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const other = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await accept(rawToken, invitee.id)

      await expect(accept(rawToken, other.id)).rejects.toMatchObject(INVALID)
    })

    it('keeps an existing membership and its role', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      await userMembershipRepository.create({
        userId: invitee.id,
        tenantId: tenant.id,
        role: 'manager',
      })
      const { rawToken } = await seedInvitation(tenant, owner, {
        email: invitee.email,
        role: 'viewer',
      })

      const accepted = await accept(rawToken, invitee.id)

      expect(accepted.role).toBe('manager')
      const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      expect(membership?.role).toBe('manager')
    })

    it('lets two concurrent accepts by the invitee both succeed, with one membership', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const results = await Promise.all([
        accept(rawToken, invitee.id),
        accept(rawToken, invitee.id),
      ])

      const expected = { tenant: { name: 'Acme Inc', slug: tenant.slug }, role: 'editor' }
      expect(results).toStrictEqual([expected, expected])
      const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from user_memberships
        where user_id = ${invitee.id} and tenant_id = ${tenant.id}
      `
      expect(row?.count).toBe(1)
    })

    it('answers invitation_invalid for a revoked invitation or a soft-deleted tenant', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const revoked = await seedInvitation(tenant, owner, { email: invitee.email })
      await revoke(tenant.id, revoked.invitation.id)
      await expect(accept(revoked.rawToken, invitee.id)).rejects.toMatchObject(INVALID)

      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await tenantRepository.softDelete(tenant.id)
      await expect(accept(rawToken, invitee.id)).rejects.toMatchObject(INVALID)
    })

    it('refuses an inactive account with 401, and claims nothing', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser({ active: false })
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      await expect(accept(rawToken, invitee.id)).rejects.toMatchObject({ statusCode: 401 })

      const unclaimed = await preview(rawToken)
      expect(unclaimed.email).toBe(invitee.email)
    })

    it('does not let a removed member rejoin with the link they already used', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await accept(rawToken, invitee.id)
      await sql`delete from user_memberships where user_id = ${invitee.id} and tenant_id = ${tenant.id}`

      await expect(accept(rawToken, invitee.id)).rejects.toMatchObject(INVALID)

      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
    })

    describe('when the claim is lost after a stale read', () => {
      it('succeeds for the invitee when their own earlier accept committed first', async () => {
        const { owner, tenant } = await setup()
        const invitee = await createUser()
        const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
        const stale = await invitationRepository.findValidByTokenHash(hashToken(rawToken))
        const first = await accept(rawToken, invitee.id)

        let second: unknown
        const claims = await withStaleRead(stale, async () => {
          second = await accept(rawToken, invitee.id)
        })

        expect(claims).toEqual([undefined])

        expect(second).toStrictEqual(first)
        const [row] = await sql<{ count: number }[]>`
          select count(*)::int as count from user_memberships
          where user_id = ${invitee.id} and tenant_id = ${tenant.id}
        `
        expect(row?.count).toBe(1)
      })

      it('answers invitation_invalid, and adds no member, when a revoke committed first', async () => {
        const { owner, tenant } = await setup()
        const invitee = await createUser()
        const { rawToken, invitation } = await seedInvitation(tenant, owner, {
          email: invitee.email,
        })
        const stale = await invitationRepository.findValidByTokenHash(hashToken(rawToken))
        await revoke(tenant.id, invitation.id)

        const claims = await withStaleRead(stale, async () => {
          await expect(accept(rawToken, invitee.id)).rejects.toMatchObject(INVALID)
        })

        expect(claims).toEqual([undefined])

        expect(
          await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
        ).toBeUndefined()
      })
    })
  })
})
