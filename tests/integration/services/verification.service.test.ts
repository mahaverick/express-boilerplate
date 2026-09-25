// tests/integration/services/verification.service.test.ts
//
// markEmailVerified against the real per-worker Postgres database. Every
// user is deleted in afterEach; token rows cascade.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UserRepository } from '@/repositories/user.repository'
import { sql, withTransaction } from '@/services/database.service'
import { markEmailVerified } from '@/services/verification.service'

const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `verification-service-${randomUUID()}@example.test`
}

describe('markEmailVerified', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  it('sets emailVerifiedAt on a never-verified user', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdIds.push(user.id)

    await markEmailVerified(user.id)

    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date)
  })

  it('is a no-op for an already-verified user: neither emailVerifiedAt nor updatedAt moves', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00.000Z')
    const user = await userRepository.create({ email: uniqueEmail(), emailVerifiedAt: verifiedAt })
    createdIds.push(user.id)

    await markEmailVerified(user.id)

    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt?.getTime()).toBe(verifiedAt.getTime())
    // updatedAt unchanged proves no UPDATE matched, not merely that it wrote the same value.
    expect(row?.updatedAt.getTime()).toBe(user.updatedAt.getTime())
  })

  it("joins the caller's transaction: a rollback undoes it", async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdIds.push(user.id)

    await expect(
      withTransaction(async (tx) => {
        await markEmailVerified(user.id, tx)
        throw new Error('roll back')
      })
    ).rejects.toThrow('roll back')

    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeNull()
  })

  it('does not verify a soft-deleted user', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdIds.push(user.id)
    await userRepository.softDelete(user.id)

    await markEmailVerified(user.id)

    const row = await userRepository.findById(user.id, { includeDeleted: true })
    expect(row?.emailVerifiedAt).toBeNull()
  })
})
