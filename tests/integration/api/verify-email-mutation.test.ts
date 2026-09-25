// tests/integration/api/verify-email-mutation.test.ts
//
// Task 7, Step 8: prove the password check in POST /auth/verify-email is
// load-bearing. The direct test ("does not verify the account when the
// password is wrong") asserts the column stays null in the DB, which no
// status-code-only test can do. This file adds a withMutatedModule proof
// that makes `isPasswordValid` always return true, then shows the direct
// test goes RED — i.e. a wrong password verifies the account when the
// comparison is bypassed.
//
// Two tests, matching claim-token-mutation.test.ts's own pattern:
//
//   1. Always on, both directions in one run: mutate isPasswordValid to
//      always return true, show that a wrong password now verifies the
//      account (the column IS written), then restore and show a fresh
//      seed + wrong password does NOT verify. This is what `pnpm test`
//      and CI run, and it is always green.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red:
//      reproduces the direct test's assertion (emailVerifiedAt is null
//      after a wrong password) against the mutated dependency, so the
//      failure shown is the actual regression test failing. Skipped by
//      default.
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/api/verify-email-mutation.test.ts   # red
//        pnpm exec vitest run tests/integration/api/verify-email-mutation.test.ts                    # green
//
// withMutatedModule re-evaluates the full module graph between
// password.utilities and app.ts, including database.service.ts — which
// opens a fresh postgres pool (max 2 connections) each time, leaked for
// the life of the worker process. Acceptable for the handful of calls a
// mutation proof needs; do not call it in a loop.
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
 * Seed an unverified user with a hashed password and a live
 * email_verification token.
 * @returns The user and raw token.
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

describe('mutation proof: isPasswordValid is load-bearing for verify-email', () => {
  it('bypassing isPasswordValid lets a wrong password verify the account; restoring it refuses', async () => {
    // MUTATED: isPasswordValid always returns true.
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

        // Under the mutation a wrong password succeeds — the column IS
        // written. This is the proof that the password check matters.
        const row = await userRepository.findById(mutatedUser.id)
        expect(row?.emailVerifiedAt).toBeInstanceOf(Date)
      }
    )

    // RESTORED: a fresh seed + wrong password must NOT verify.
    const { user: restoredUser, token: restoredToken } = await seedUnverifiedUser()
    const { createApp } = await import('@/app')
    const restoredApp = createApp()
    await request(restoredApp)
      .post('/api/v1/auth/verify-email')
      .send({ token: restoredToken, password: 'not-the-right-password' })

    const row = await userRepository.findById(restoredUser.id)
    expect(row?.emailVerifiedAt).toBeNull()
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is
  // green.
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

          // The real test asserts this is null; under the mutation it is a
          // Date instead, so this assertion fails — proving the password
          // check is load-bearing.
          const row = await userRepository.findById(user.id)
          expect(row?.emailVerifiedAt).toBeNull()
        }
      )
    }
  )
})
