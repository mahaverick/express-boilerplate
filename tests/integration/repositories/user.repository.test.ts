// tests/integration/repositories/user.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts) — this file inserts and mutates rows,
// so every email it uses is unique to this run (never a fixed literal) and
// every row it creates is deleted in afterEach. Other tests in the same
// worker share this database; a fixed email here would eventually collide
// with one of them, intermittently, in whichever worker happens to run
// both files.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `user-repo-${randomUUID()}@example.test`
}

describe('UserRepository', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  it('creates a user and finds it again by id', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)

    expect(created.id).toBeTruthy()
    expect(created.email).toBe(email)
    expect(created.deletedAt).toBeNull()

    const found = await userRepository.findById(created.id)
    expect(found).toMatchObject({ id: created.id, email })
  })

  it('returns undefined from findById for an id that does not exist', async () => {
    expect(await userRepository.findById(randomUUID())).toBeUndefined()
  })

  it('finds a user by email regardless of case', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)

    expect(await userRepository.findByEmail(email.toUpperCase())).toMatchObject({ id: created.id })
    expect(await userRepository.findByEmail(email.toLowerCase())).toMatchObject({ id: created.id })
  })

  it('returns undefined from findByEmail for an email that does not exist', async () => {
    expect(await userRepository.findByEmail(uniqueEmail())).toBeUndefined()
  })

  it('excludes a soft-deleted user from findById and findByEmail by default', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)

    const deleted = await userRepository.softDelete(created.id)
    expect(deleted?.deletedAt).not.toBeNull()

    expect(await userRepository.findById(created.id)).toBeUndefined()
    expect(await userRepository.findByEmail(email)).toBeUndefined()
  })

  it('returns a soft-deleted user from findById and findByEmail when includeDeleted is set', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)
    await userRepository.softDelete(created.id)

    const byId = await userRepository.findById(created.id, { includeDeleted: true })
    expect(byId?.id).toBe(created.id)
    expect(byId?.deletedAt).not.toBeNull()

    const byEmail = await userRepository.findByEmail(email, { includeDeleted: true })
    expect(byEmail?.id).toBe(created.id)
  })

  it('softDelete is a no-op returning undefined for a missing or already-deleted row', async () => {
    expect(await userRepository.softDelete(randomUUID())).toBeUndefined()

    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)
    await userRepository.softDelete(created.id)

    expect(await userRepository.softDelete(created.id)).toBeUndefined()
  })

  it('rejects a duplicate email with HttpError(409) rather than a raw driver error', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)

    // Exercises the translation this task exists to add: without it, this
    // assertion fails with a raw PostgresError (23505) instead of HttpError.
    await expect(userRepository.create({ email: email.toUpperCase() })).rejects.toBeInstanceOf(
      HttpError
    )
    await expect(userRepository.create({ email })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('updates a user and bumps updatedAt', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)

    const updated = await userRepository.update(created.id, { firstName: 'Ada' })

    expect(updated?.firstName).toBe('Ada')
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('rejects an update that would duplicate another user’s email with HttpError(409)', async () => {
    const emailOne = uniqueEmail()
    const emailTwo = uniqueEmail()
    const first = await userRepository.create({ email: emailOne })
    const second = await userRepository.create({ email: emailTwo })
    createdIds.push(first.id, second.id)

    await expect(userRepository.update(second.id, { email: emailOne })).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('returns undefined from update for an id that does not exist', async () => {
    expect(await userRepository.update(randomUUID(), { firstName: 'Nobody' })).toBeUndefined()
  })

  it('does not update a soft-deleted row by default, and does when includeDeleted is set', async () => {
    const email = uniqueEmail()
    const created = await userRepository.create({ email })
    createdIds.push(created.id)
    await userRepository.softDelete(created.id)

    expect(await userRepository.update(created.id, { firstName: 'Ghost' })).toBeUndefined()

    const updated = await userRepository.update(
      created.id,
      { firstName: 'Ghost' },
      { includeDeleted: true }
    )
    expect(updated?.firstName).toBe('Ghost')
  })

  describe('markEmailVerified', () => {
    it('sets email_verified_at and bumps updated_at', async () => {
      const user = await userRepository.create({ email: uniqueEmail(), passwordHash: 'x' })
      createdIds.push(user.id)

      const verified = await userRepository.markEmailVerified(user.id)

      expect(verified?.emailVerifiedAt).toBeInstanceOf(Date)
      expect(verified?.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
    })

    it('leaves an already-verified timestamp untouched and returns undefined', async () => {
      const user = await userRepository.create({ email: uniqueEmail(), passwordHash: 'x' })
      createdIds.push(user.id)
      const first = await userRepository.markEmailVerified(user.id)
      // Must prove the first call actually verified the row — otherwise
      // `first?.emailVerifiedAt` below is `undefined`, and comparing it
      // against a second `undefined` would pass without proving anything.
      expect(first).toBeDefined()

      const second = await userRepository.markEmailVerified(user.id)

      // undefined is SUCCESS here, not failure — it is how the caller learns
      // the row was already verified. verification.controller.ts depends on
      // this: a second valid token must answer 200, not 400.
      expect(second).toBeUndefined()
      const reread = await userRepository.findById(user.id)
      expect(reread?.emailVerifiedAt?.getTime()).toBe(first?.emailVerifiedAt?.getTime())
    })

    it('returns undefined for a user that does not exist', async () => {
      expect(await userRepository.markEmailVerified(randomUUID())).toBeUndefined()
    })
  })
})
