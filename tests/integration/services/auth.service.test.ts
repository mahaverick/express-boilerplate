// tests/integration/services/auth.service.test.ts
//
// The controller starts register's follow-up mail, requestPasswordReset and
// the resend-verification mail with a bare `void` after replying, so each
// must swallow and log its own failure: a rejection there would crash the
// process on one branch only. Faults are injected with withMutatedMethod;
// nothing under src/ is edited. Each test also asserts the failure was
// logged, so a fault that never reached the work cannot pass vacuously, and
// that the log carries none of the failed query's bound parameters.
// login's platform-role read is guarded the same way: a failed read answers
// null instead of failing the sign-in.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { login, register, requestPasswordReset } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { prepareResendVerification } from '@/services/verification.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { fakeQueryError, LEAKED_PARAM, loggedText } from '../../helpers/query-error'

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-service-${randomUUID()}@example.test`
}

/**
 * Throw from a repository method, to simulate a failed query.
 * @returns Never; always rejects with a query error carrying `LEAKED_PARAM`.
 */
function failingQuery(): Promise<never> {
  return Promise.reject(fakeQueryError())
}

describe('post-reply work never rejects', () => {
  const createdEmails: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    if (createdEmails.length === 0) return
    await sql`delete from users where lower(email) = any(${createdEmails.map((email) => email.toLowerCase())})`
    createdEmails.length = 0
  })

  it("register's follow-up for a free address resolves even when issuing the token fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    const sendFollowUpMail = await register({ email, password: VALID_PASSWORD })
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserTokenRepository.prototype, 'create', failingQuery, async () => {
      await expect(sendFollowUpMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Verification mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it("register's follow-up for a taken address resolves even when the lookup fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD })
    const sendFollowUpMail = await register({ email, password: VALID_PASSWORD })
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', failingQuery, async () => {
      await expect(sendFollowUpMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Registration-attempt mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it('requestPasswordReset resolves even when the lookup fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', failingQuery, async () => {
      await expect(requestPasswordReset(uniqueEmail())).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Forgot-password mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it("prepareResendVerification's mail resolves even when issuing the token fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD })
    const sendMail = await prepareResendVerification(email)
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserTokenRepository.prototype, 'create', failingQuery, async () => {
      await expect(sendMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Resend verification mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it('login answers a null platform role, and logs the failed read without its parameters', async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD })
    await sql`update users set email_verified_at = now() where lower(email) = ${email.toLowerCase()}`
    const warnSpy = vi.spyOn(logger, 'warn')

    let platformRole: unknown
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'findPlatformRole',
      failingQuery,
      async () => {
        ;({ platformRole } = await login({ email, password: VALID_PASSWORD }))
      }
    )

    expect(platformRole).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      'Platform role could not be read for the login response',
      expect.anything()
    )
    expect(loggedText(warnSpy)).not.toContain(LEAKED_PARAM)
  })
})
