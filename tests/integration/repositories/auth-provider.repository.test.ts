// tests/integration/repositories/auth-provider.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every user this file creates is
// deleted in afterEach — deleting the user is enough: auth_providers.user_id
// carries ON DELETE CASCADE (auth-provider.model.ts), so a row this file
// never explicitly deletes is still gone once its owning user is. One test
// below asserts that property directly, same convention
// notification.repository.test.ts uses for its own cascade.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const authProviderRepository = new AuthProviderRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-provider-repo-${randomUUID()}@example.test`
}

describe('AuthProviderRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user for a test to own provider rows with, tracked for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  describe('create', () => {
    it('inserts an email provider row and returns the generated columns', async () => {
      const userId = await createUser()
      const email = uniqueEmail()

      const row = await authProviderRepository.create({
        userId,
        provider: 'email',
        providerId: email,
      })

      expect(row.id).toBeTruthy()
      expect(row.userId).toBe(userId)
      expect(row.provider).toBe('email')
      expect(row.providerId).toBe(email)
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    })

    it('inserts a google provider row', async () => {
      const userId = await createUser()
      const googleId = randomUUID()

      const row = await authProviderRepository.create({
        userId,
        provider: 'google',
        providerId: googleId,
      })

      expect(row.provider).toBe('google')
      expect(row.providerId).toBe(googleId)
    })

    it('lets the same user hold both an email and a google row', async () => {
      const userId = await createUser()

      await authProviderRepository.create({ userId, provider: 'email', providerId: uniqueEmail() })
      await authProviderRepository.create({
        userId,
        provider: 'google',
        providerId: randomUUID(),
      })

      const rows = await authProviderRepository.findByUser(userId)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.provider).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'email',
        'google',
      ])
    })

    it('rejects a duplicate (provider, providerId) pair with HttpError(409)', async () => {
      const firstUserId = await createUser()
      const secondUserId = await createUser()
      const googleId = randomUUID()

      await authProviderRepository.create({
        userId: firstUserId,
        provider: 'google',
        providerId: googleId,
      })

      await expect(
        authProviderRepository.create({
          userId: secondUserId,
          provider: 'google',
          providerId: googleId,
        })
      ).rejects.toMatchObject({ name: 'HttpError', statusCode: 409 })
    })

    // The catch block's OTHER branch: `isUniqueViolation` false, so the
    // original error propagates unchanged rather than becoming an
    // HttpError(409) meant for a (provider, providerId) collision
    // specifically. A foreign-key violation on `userId` (naming no real
    // user) is a real, different failure `create`'s own transaction-free
    // insert can hit — mirrors tenant.repository.test.ts's identical case
    // for `TenantRepository.create`.
    it('propagates a non-collision database error unchanged, e.g. a foreign-key violation on userId', async () => {
      await expect(
        authProviderRepository.create({
          userId: randomUUID(),
          provider: 'email',
          providerId: uniqueEmail(),
        })
      ).rejects.not.toMatchObject({ name: 'HttpError' })
    })

    it('allows the same providerId under different providers', async () => {
      const userId = await createUser()
      const sharedValue = randomUUID()

      await authProviderRepository.create({ userId, provider: 'email', providerId: sharedValue })
      const row = await authProviderRepository.create({
        userId,
        provider: 'google',
        providerId: sharedValue,
      })

      expect(row.provider).toBe('google')
    })

    // Load-bearing test for this task's own deviation from the brief:
    // `auth_providers_provider_check` (auth-provider.model.ts) is a schema
    // guarantee this task introduced, not something the brief asked for —
    // same standard notification.repository.test.ts's cascade test holds
    // itself to ("a schema guarantee this task itself introduced, not an
    // assumption to leave unverified"). `AuthProviderRepository.create`'s
    // parameter type already blocks an invalid `provider` at compile time,
    // so this goes around it via a raw insert to prove the database itself
    // — not just TypeScript — rejects it.
    it('rejects an unknown provider at the database, not just in TypeScript', async () => {
      const userId = await createUser()
      await expect(
        sql`insert into auth_providers (user_id, provider, provider_id) values (${userId}, 'facebook', 'x')`
      ).rejects.toMatchObject({ code: '23514' }) // check_violation
    })
  })

  describe('findByProviderAndId', () => {
    it('finds an email provider row by provider and id', async () => {
      const userId = await createUser()
      const email = uniqueEmail()
      await authProviderRepository.create({ userId, provider: 'email', providerId: email })

      const found = await authProviderRepository.findByProviderAndId('email', email)
      expect(found?.userId).toBe(userId)
    })

    it('finds a google provider row by provider and id', async () => {
      const userId = await createUser()
      const googleId = randomUUID()
      await authProviderRepository.create({ userId, provider: 'google', providerId: googleId })

      const found = await authProviderRepository.findByProviderAndId('google', googleId)
      expect(found?.userId).toBe(userId)
    })

    it('returns undefined for a providerId that does not exist', async () => {
      expect(
        await authProviderRepository.findByProviderAndId('google', randomUUID())
      ).toBeUndefined()
    })

    it('does not match the same providerId under a different provider', async () => {
      const userId = await createUser()
      const sharedValue = randomUUID()
      await authProviderRepository.create({ userId, provider: 'email', providerId: sharedValue })

      expect(
        await authProviderRepository.findByProviderAndId('google', sharedValue)
      ).toBeUndefined()
    })
  })

  describe('findByUser', () => {
    it('returns every provider row for a user', async () => {
      const userId = await createUser()
      await authProviderRepository.create({ userId, provider: 'email', providerId: uniqueEmail() })
      await authProviderRepository.create({
        userId,
        provider: 'google',
        providerId: randomUUID(),
      })

      const rows = await authProviderRepository.findByUser(userId)
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.userId === userId)).toBe(true)
    })

    it('returns an empty array for a user with no linked providers', async () => {
      const userId = await createUser()
      expect(await authProviderRepository.findByUser(userId)).toEqual([])
    })

    it('does not return another user’s provider rows', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await authProviderRepository.create({
        userId: otherUserId,
        provider: 'email',
        providerId: uniqueEmail(),
      })

      expect(await authProviderRepository.findByUser(userId)).toEqual([])
    })
  })

  describe('deleteFederatedForUser', () => {
    it('deletes only non-email provider rows, keeping the email row', async () => {
      const userId = await createUser()
      await authProviderRepository.create({ userId, provider: 'email', providerId: uniqueEmail() })
      await authProviderRepository.create({
        userId,
        provider: 'google',
        providerId: randomUUID(),
      })

      await authProviderRepository.deleteFederatedForUser(userId)

      const rows = await authProviderRepository.findByUser(userId)
      expect(rows.map((row) => row.provider)).toEqual(['email'])
    })

    it('does not touch another user’s provider rows', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await authProviderRepository.create({
        userId: otherUserId,
        provider: 'google',
        providerId: randomUUID(),
      })

      await authProviderRepository.deleteFederatedForUser(userId)

      const otherRows = await authProviderRepository.findByUser(otherUserId)
      expect(otherRows.map((row) => row.provider)).toEqual(['google'])
    })
  })

  describe('releaseEmailOfDeletedUsers', () => {
    it("deletes a soft-deleted user's email row, keeping its google row", async () => {
      const userId = await createUser()
      const email = uniqueEmail()
      await authProviderRepository.create({ userId, provider: 'email', providerId: email })
      await authProviderRepository.create({ userId, provider: 'google', providerId: randomUUID() })
      await userRepository.softDelete(userId)

      const released = await authProviderRepository.releaseEmailOfDeletedUsers(email)

      expect(released).toBe(1)
      const remaining = await authProviderRepository.findByUser(userId)
      expect(remaining.map((row) => row.provider)).toEqual(['google'])
    })

    it("never touches a live user's email row", async () => {
      const userId = await createUser()
      const email = uniqueEmail()
      await authProviderRepository.create({ userId, provider: 'email', providerId: email })

      const released = await authProviderRepository.releaseEmailOfDeletedUsers(email)

      expect(released).toBe(0)
      expect(await authProviderRepository.findByProviderAndId('email', email)).toBeDefined()
    })
  })

  it('deletes a user’s provider rows automatically via ON DELETE CASCADE', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    const row = await authProviderRepository.create({
      userId: user.id,
      provider: 'google',
      providerId: randomUUID(),
    })

    await sql`delete from users where id = ${user.id}`
    // The user row is gone without ever being tracked in createdUserIds
    // above — afterEach has nothing to clean up here, deliberately, since
    // this test's own point is that the cascade already did it.

    const [remaining] = await sql`select * from auth_providers where id = ${row.id}`
    expect(remaining).toBeUndefined()
  })
})
