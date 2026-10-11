/**
 * @file Proves the password check in POST /auth/verify-email is
 * load-bearing: a status-code-only test cannot show that the
 * emailVerifiedAt column stays null when a wrong password should have
 * been refused. The describe block below explains the two-test pattern.
 */

import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { issueToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { withMutatedModule } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const userRepository = new UserRepository()
const VALID_PASSWORD = 'correct horse battery staple'

const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

/**
 * Seeds an unverified user with a hashed password and a live
 * email_verification token, returning the raw token.
 */
async function seedUnverifiedUser(): Promise<{ user: { id: string }; token: string }> {
  const user = await userRepository.create({
    email: `verify-mutation-${randomUUID()}@example.com`,
    passwordHash: await hashPassword(VALID_PASSWORD),
  })
  createdIds.push(user.id)

  const issued = await issueToken(user.id, 'email_verification', 60_000)
  return { user, token: issued.raw }
}

/**
 * Two tests, following claim-token-mutation.test.ts:
 *
 *   1. Always runs and passes, covering both directions: with
 *      isPasswordValid mutated to always return true, a wrong password
 *      verifies the account (the column is written); restored, a fresh seed
 *      and a wrong password do not.
 *
 *   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, red by design: it
 *      asserts the real test's expectation (emailVerifiedAt is null after a
 *      wrong password) against the mutated dependency, so the failure shown
 *      is the regression test itself failing. Skipped by default:
 *
 *        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/api/verify-email-mutation.test.ts   # red
 *        pnpm exec vitest run tests/integration/api/verify-email-mutation.test.ts                    # green
 *
 * withMutatedModule re-evaluates the module graph between password.utilities
 * and app.ts, including database.service.ts, which opens a new postgres pool
 * (`DB_POOL_MAX`) each time and nothing closes it. Fine for the few calls a
 * mutation proof needs; do not call it in a loop.
 */
describe('mutation proof: isPasswordValid is load-bearing for verify-email', () => {
  it('bypassing isPasswordValid lets a wrong password verify the account; restoring it refuses', async () => {
    // Mutated: isPasswordValid always returns true.
    const { user: mutatedUser, token: mutatedToken } = await seedUnverifiedUser()

    await withMutatedModule(
      '@/utilities/password.utilities',
      { isPasswordValid: () => Promise.resolve(true) },
      () => import('@/app'),
      async (appModule) => {
        const mutatedApp = appModule.createApp()
        await request(mutatedApp)
          .post('/api/v1/auth/verify-email')
          .send({ token: mutatedToken, password: 'not-the-right-password' })

        // Under the mutation a wrong password verifies the account, so the password check is what prevents it.
        const row = await userRepository.findById(mutatedUser.id)
        expect(row?.emailVerifiedAt).toBeInstanceOf(Date)
      }
    )

    // Restored: a fresh seed and a wrong password must not verify.
    const { user: restoredUser, token: restoredToken } = await seedUnverifiedUser()
    const { createApp } = await import('@/app')
    const restoredApp = createApp()
    await request(restoredApp)
      .post('/api/v1/auth/verify-email')
      .send({ token: restoredToken, password: 'not-the-right-password' })

    const row = await userRepository.findById(restoredUser.id)
    expect(row?.emailVerifiedAt).toBeNull()
  })

  // Red by design under MUTATION_PROOF=1 (see the describe's comment); skipped otherwise.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the direct test assertion against the mutated dependency',
    async () => {
      const { user, token } = await seedUnverifiedUser()

      await withMutatedModule(
        '@/utilities/password.utilities',
        { isPasswordValid: () => Promise.resolve(true) },
        () => import('@/app'),
        async (appModule) => {
          const mutatedApp = appModule.createApp()
          await request(mutatedApp)
            .post('/api/v1/auth/verify-email')
            .send({ token, password: 'not-the-right-password' })

          // The real test asserts null here; under the mutation it is a Date, which is the failure this test shows.
          const row = await userRepository.findById(user.id)
          expect(row?.emailVerifiedAt).toBeNull()
        }
      )
    }
  )
})
