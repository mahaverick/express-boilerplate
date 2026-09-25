// tests/integration/api/platform-auto-join.test.ts
//
// Auto-join through the paths that call it: password login, Google sign-in
// and markEmailVerified, with PLATFORM_EMAIL_DOMAINS set. getEnv() memoises
// the first environment it parses, and database.service.ts parses it at
// module scope, so the variable is stubbed in beforeAll and every runtime
// module is imported after it (google-oauth.test.ts explains the pattern).
// The suite's own environment leaves the variable unset.
//
// Auto-join writes audit rows, so afterEach empties audit_logs, as every
// file that writes them does, before deleting this file's users (which
// cascades to their memberships, providers and tokens).
import { randomUUID } from 'node:crypto'
import { sql as drizzleSql } from 'drizzle-orm'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import type { AuthProviderRepository as AuthProviderRepositoryClass } from '@/repositories/auth-provider.repository'
import type { UserMembershipRepository as UserMembershipRepositoryClass } from '@/repositories/user-membership.repository'
import type { UserRepository as UserRepositoryClass } from '@/repositories/user.repository'
import type { db as DbType, sql as SqlType } from '@/services/database.service'
import type { completeGoogleSignIn as CompleteGoogleSignInType } from '@/services/google-auth.service'
import type { logger as LoggerType } from '@/services/logger.service'
import type { markEmailVerified as MarkEmailVerifiedType } from '@/services/verification.service'
import type { hashPassword as HashPasswordType } from '@/utilities/password.utilities'
import type { truncateAuditLogs as TruncateAuditLogsType } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const STAFF_DOMAIN = 'staff.example.test'
const PASSWORD = 'correct horse battery staple'

/**
 * A fresh address on the auto-join domain.
 * @returns The address.
 */
function staffEmail(): string {
  return `auto-join-${randomUUID()}@${STAFF_DOMAIN}`
}

/**
 * A Google profile for `email`, verified by Google, shaped like what
 * passport hands the callback (google-oauth.test.ts's fixture, trimmed).
 * @param email - The address Google reports.
 * @param id - Google's stable profile id.
 * @returns The profile.
 */
function googleProfile(email: string, id: string = randomUUID()): GoogleProfile {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Staff User',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      email,
      email_verified: true,
    },
  }
}

describe('platform auto-join (PLATFORM_EMAIL_DOMAINS set)', () => {
  let app: ReturnType<typeof CreateApp>
  let userRepository: InstanceType<typeof UserRepositoryClass>
  let authProviderRepository: InstanceType<typeof AuthProviderRepositoryClass>
  let membershipRepositoryClass: typeof UserMembershipRepositoryClass
  let membershipRepository: InstanceType<typeof UserMembershipRepositoryClass>
  let db: typeof DbType
  let sql: typeof SqlType
  let completeGoogleSignIn: typeof CompleteGoogleSignInType
  let markEmailVerified: typeof MarkEmailVerifiedType
  let hashPassword: typeof HashPasswordType
  let logger: typeof LoggerType
  let truncateAuditLogs: typeof TruncateAuditLogsType

  beforeAll(async () => {
    vi.stubEnv('PLATFORM_EMAIL_DOMAINS', STAFF_DOMAIN)
    const { createApp } = await import('@/app')
    app = createApp()
    const { UserRepository } = await import('@/repositories/user.repository')
    userRepository = new UserRepository()
    const { AuthProviderRepository } = await import('@/repositories/auth-provider.repository')
    authProviderRepository = new AuthProviderRepository()
    const { UserMembershipRepository } = await import('@/repositories/user-membership.repository')
    membershipRepositoryClass = UserMembershipRepository
    membershipRepository = new UserMembershipRepository()
    const database = await import('@/services/database.service')
    db = database.db
    sql = database.sql
    const googleAuthService = await import('@/services/google-auth.service')
    completeGoogleSignIn = googleAuthService.completeGoogleSignIn
    const verificationService = await import('@/services/verification.service')
    markEmailVerified = verificationService.markEmailVerified
    const passwordUtilities = await import('@/utilities/password.utilities')
    hashPassword = passwordUtilities.hashPassword
    const loggerService = await import('@/services/logger.service')
    logger = loggerService.logger
    // Dynamic too: the helper imports database.service.
    const auditLogHelper = await import('../../helpers/audit-log')
    truncateAuditLogs = auditLogHelper.truncateAuditLogs
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    vi.restoreAllMocks()
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user, tracked for cleanup. Verification is written with raw SQL
   * so it does not itself trigger auto-join: this is a user verified before
   * the domain was listed.
   * @param email - The address.
   * @param options - Setup choices.
   * @param options.hasPassword - Give the account PASSWORD.
   * @param options.isVerified - Mark the address verified.
   * @returns The user as stored.
   */
  async function createUser(
    email: string,
    options: { hasPassword: boolean; isVerified: boolean }
  ): Promise<User> {
    const passwordHash = options.hasPassword ? await hashPassword(PASSWORD) : undefined
    const user = await userRepository.create({ email, ...(passwordHash && { passwordHash }) })
    createdUserIds.push(user.id)
    if (options.isVerified) {
      await sql`update users set email_verified_at = now() where id = ${user.id}`
    }
    const stored = await userRepository.findById(user.id)
    if (!stored) throw new Error('setup: user vanished')
    return stored
  }

  /**
   * The user's platform role, read straight from the repository.
   * @param userId - The user.
   * @returns The role, or null when the user is not staff.
   */
  async function platformRoleOf(userId: string): Promise<string | null> {
    return membershipRepository.findPlatformRole(userId)
  }

  /**
   * How many auto-join audit rows name this user.
   * @param userId - The user.
   * @returns The row count.
   */
  async function autoJoinedRowCount(userId: string): Promise<number> {
    const rows = await sql`
      select id from audit_logs
      where action = 'platform.member.auto_joined' and metadata->>'userId' = ${userId}
    `
    return rows.length
  }

  /**
   * A stand-in for insertIfAbsent that raises a real SQL error, so
   * Postgres aborts whatever transaction ran it.
   * @param _data - The membership, ignored.
   * @param executor - Where the failing query runs.
   * @returns Rejects with Postgres's division-by-zero error.
   */
  const failingInsert: InstanceType<
    typeof UserMembershipRepositoryClass
  >['insertIfAbsent'] = async (_data, executor = db) => {
    await executor.execute(drizzleSql`select 1 / 0`)
  }

  /**
   * Log in over HTTP.
   * @param email - The address.
   * @param password - The password to try.
   * @returns The response.
   */
  async function login(email: string, password: string): Promise<Response> {
    return request(app).post('/api/v1/auth/login').send({ email, password })
  }

  describe('password login', () => {
    it('joins a user verified before the domain was listed, as viewer, on their next login', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: true })

      const response = await login(user.email, PASSWORD)

      expect(response.status).toBe(200)
      expect(await platformRoleOf(user.id)).toBe('viewer')
      expect(await autoJoinedRowCount(user.id)).toBe(1)
    })

    it('never joins on a failed credential check', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: true })

      const response = await login(user.email, 'definitely-the-wrong-password')

      expect(response.status).toBe(401)
      expect(await platformRoleOf(user.id)).toBeNull()
    })

    it('never joins an unverified account, which cannot log in either', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: false })

      const response = await login(user.email, PASSWORD)

      expect(response.status).toBe(401)
      expect(await platformRoleOf(user.id)).toBeNull()
    })

    it('does not join an address off the list', async () => {
      const user = await createUser(`auto-join-${randomUUID()}@example.test`, {
        hasPassword: true,
        isVerified: true,
      })

      const response = await login(user.email, PASSWORD)

      expect(response.status).toBe(200)
      expect(await platformRoleOf(user.id)).toBeNull()
    })

    it('keeps an existing platform role: a staff admin is not demoted to viewer', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: true })
      const [platform] = await sql<{ id: string }[]>`select id from tenants where is_platform`
      if (!platform) throw new Error('setup: migration 0016 seeds the platform tenant')
      await membershipRepository.create({ userId: user.id, tenantId: platform.id, role: 'admin' })

      const response = await login(user.email, PASSWORD)

      expect(response.status).toBe(200)
      expect(await platformRoleOf(user.id)).toBe('admin')
      expect(await autoJoinedRowCount(user.id)).toBe(0)
    })

    it('logs an auto-join failure at warn and still signs the user in', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: true })
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      await withMutatedMethod(
        membershipRepositoryClass.prototype,
        'insertIfAbsent',
        () => Promise.reject(new Error('membership insert failed')),
        async () => {
          const response = await login(user.email, PASSWORD)

          expect(response.status).toBe(200)
          const cookies = response.headers['set-cookie'] as unknown as string[] | undefined
          expect(
            cookies?.some((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
          ).toBe(true)
        }
      )

      expect(warn).toHaveBeenCalledWith(
        'Platform auto-join failed',
        expect.objectContaining({ userId: user.id })
      )
      expect(await platformRoleOf(user.id)).toBeNull()
    })
  })

  describe('Google sign-in', () => {
    it('joins a linked user verified before the domain was listed, on their next Google sign-in', async () => {
      const user = await createUser(staffEmail(), { hasPassword: false, isVerified: true })
      const googleId = randomUUID()
      await authProviderRepository.create({
        userId: user.id,
        provider: 'google',
        providerId: googleId,
      })

      await completeGoogleSignIn(googleProfile(user.email, googleId))

      expect(await platformRoleOf(user.id)).toBe('viewer')
    })

    it('joins a new account Google verified, exactly once', async () => {
      const email = staffEmail()

      await completeGoogleSignIn(googleProfile(email))

      const created = await userRepository.findByEmail(email)
      if (!created) throw new Error('completeGoogleSignIn created no user')
      createdUserIds.push(created.id)
      expect(await platformRoleOf(created.id)).toBe('viewer')
      expect(await autoJoinedRowCount(created.id)).toBe(1)
    })

    it('joins an unverified account that a Google-verified identity claims', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: false })

      await completeGoogleSignIn(googleProfile(user.email))

      expect(await platformRoleOf(user.id)).toBe('viewer')
    })

    it('keeps a new Google account when auto-join fails inside the sign-up transaction', async () => {
      const email = staffEmail()
      vi.spyOn(logger, 'warn').mockImplementation(() => {})

      await withMutatedMethod(
        membershipRepositoryClass.prototype,
        'insertIfAbsent',
        failingInsert,
        async () => {
          await expect(completeGoogleSignIn(googleProfile(email))).resolves.toBeDefined()
        }
      )

      const created = await userRepository.findByEmail(email)
      if (!created) throw new Error('the sign-up transaction rolled back')
      createdUserIds.push(created.id)
      expect(created.emailVerifiedAt).not.toBeNull()
      expect(await platformRoleOf(created.id)).toBeNull()
    })
  })

  describe('markEmailVerified', () => {
    it('joins on the transition to verified', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: false })

      await markEmailVerified(user.id)

      expect(await platformRoleOf(user.id)).toBe('viewer')
      expect(await autoJoinedRowCount(user.id)).toBe(1)
    })

    it('does nothing for an address that was already verified', async () => {
      const user = await createUser(staffEmail(), { hasPassword: true, isVerified: true })

      await markEmailVerified(user.id)

      expect(await platformRoleOf(user.id)).toBeNull()
    })
  })
})
