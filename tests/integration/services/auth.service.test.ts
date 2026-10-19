/**
 * @file Proves that the guarded platform-role read in `auth.service.ts`
 * (`platformRoleForLogin`) answers null instead of failing a sign-in, and
 * never leaks a failed query's bound parameters into the log. The fault is
 * injected with `withMutatedMethod`; nothing under `src/` is edited.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { verifySignInLink } from '@/services/sign-in-link.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { fakeQueryError, LEAKED_PARAM, loggedText } from '../../helpers/query-error'
import { issueTestLink } from '../../helpers/sign-in'

/**
 * Returns an address no other test row shares, for a user the test creates.
 */
function uniqueEmail(): string {
  return `auth-service-${randomUUID()}@example.test`
}

/**
 * Stands in for a repository method whose query fails with an error carrying `LEAKED_PARAM`.
 */
function failingQuery(): Promise<never> {
  return Promise.reject(fakeQueryError())
}

describe('platformRoleForLogin', () => {
  const createdEmails: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    if (createdEmails.length === 0) return
    await sql`delete from users where lower(email) = any(${createdEmails})`
    createdEmails.length = 0
  })

  it('answers a null platform role to a link sign-in, and logs the failed read without its parameters', async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    const token = await issueTestLink(email)
    const warnSpy = vi.spyOn(logger, 'warn')

    let platformRole: unknown
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'findPlatformRole',
      failingQuery,
      async () => {
        ;({ platformRole } = await verifySignInLink(token))
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
