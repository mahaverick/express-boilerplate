// tests/integration/services/auth.service.test.ts
//
// The controller starts register's follow-up mail, requestPasswordReset and
// the resend-verification mail with a bare `void` after replying, so each
// must swallow and log its own failure: a rejection there would crash the
// process on one branch only. Faults are injected with withMutatedMethod;
// nothing under src/ is edited. Each test also asserts the failure was
// logged, so a fault that never reached the work cannot pass vacuously.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { register, requestPasswordReset } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { prepareResendVerification } from '@/services/verification.service'
import { withMutatedMethod } from '../../helpers/mutate'

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-service-${randomUUID()}@example.test`
}

/**
 * Throw from a repository method, to simulate a database failure.
 * @returns Never; always rejects.
 */
function failingQuery(): Promise<never> {
  return Promise.reject(new Error('simulated database failure'))
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
  })

  it('requestPasswordReset resolves even when the lookup fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', failingQuery, async () => {
      await expect(requestPasswordReset(uniqueEmail())).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Forgot-password mail failed', expect.anything())
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
  })
})
