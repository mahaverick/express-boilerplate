/**
 * @file Integration test against the real per-worker Postgres database.
 * Every user this file creates is deleted in `afterEach`; `user_passkeys.user_id`
 * carries `ON DELETE CASCADE`, so its passkey rows go with it.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { NewUserPasskey } from '@/database/models/user-passkey.model'
import { HttpError } from '@/errors/http-error'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const passkeyRepository = new UserPasskeyRepository()
const userRepository = new UserRepository()

/**
 * A passkey row with every column set, for one user.
 */
function passkeyFor(userId: string, overrides: Partial<NewUserPasskey> = {}): NewUserPasskey {
  return {
    userId,
    credentialId: `cred-${randomUUID()}`,
    publicKey: new Uint8Array([0, 1, 2, 127, 128, 254, 255]),
    signCount: 7,
    transports: ['internal', 'hybrid'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    backupEligible: true,
    backupState: false,
    name: 'Laptop',
    ...overrides,
  }
}

describe('UserPasskeyRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates a user for a test to own passkeys, tracked for cleanup.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({
      email: `passkey-repo-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return user.id
  }

  describe('create and findByCredentialId', () => {
    it('round-trips every column, including the public key bytes', async () => {
      const userId = await createUser()
      const input = passkeyFor(userId)

      const created = await passkeyRepository.create(input)
      const found = await passkeyRepository.findByCredentialId(input.credentialId)

      expect(found).toEqual(created)
      expect(found?.userId).toBe(userId)
      expect(found?.credentialId).toBe(input.credentialId)
      expect(Buffer.from(found?.publicKey ?? []).equals(Buffer.from(input.publicKey))).toBe(true)
      expect(found?.publicKey).toBeInstanceOf(Uint8Array)
      expect(found?.signCount).toBe(7)
      expect(found?.transports).toEqual(['internal', 'hybrid'])
      expect(found?.aaguid).toBe(input.aaguid)
      expect(found?.backupEligible).toBe(true)
      expect(found?.backupState).toBe(false)
      expect(found?.name).toBe('Laptop')
      expect(found?.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(found?.createdAt).toBeInstanceOf(Date)
      expect(found?.lastUsedAt).toBeNull()
    })

    it('defaults sign_count to 0 and transports to empty', async () => {
      const userId = await createUser()
      const input = passkeyFor(userId)

      const created = await passkeyRepository.create({
        userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        aaguid: input.aaguid,
        backupEligible: true,
        backupState: false,
        name: 'Laptop',
      })

      expect(created.signCount).toBe(0)
      expect(created.transports).toEqual([])
    })

    it('returns undefined for an unknown credential', async () => {
      expect(await passkeyRepository.findByCredentialId(`nope-${randomUUID()}`)).toBeUndefined()
    })

    it('maps a duplicate credential_id to a 409 HttpError', async () => {
      const userId = await createUser()
      const first = await passkeyRepository.create(passkeyFor(userId))

      let error: unknown
      try {
        await passkeyRepository.create(passkeyFor(userId, { credentialId: first.credentialId }))
      } catch (error_) {
        error = error_
      }

      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).statusCode).toBe(409)
      expect((error as HttpError).code).toBe('PASSKEY_EXISTS')
    })
  })

  describe('listByUser and countByUser', () => {
    it('lists oldest first and counts only that user', async () => {
      const userId = await createUser()
      const otherId = await createUser()
      const older = await passkeyRepository.create(passkeyFor(userId, { name: 'Older' }))
      await sql`update user_passkeys set created_at = now() - interval '1 day' where id = ${older.id}`
      const newer = await passkeyRepository.create(passkeyFor(userId, { name: 'Newer' }))
      await passkeyRepository.create(passkeyFor(otherId))

      const rows = await passkeyRepository.listByUser(userId)

      expect(rows.map((row) => row.id)).toEqual([older.id, newer.id])
      expect(await passkeyRepository.countByUser(userId)).toBe(2)
      expect(await passkeyRepository.countByUser(otherId)).toBe(1)
    })

    it('returns an empty list and zero for a user with none', async () => {
      const userId = await createUser()

      expect(await passkeyRepository.listByUser(userId)).toEqual([])
      expect(await passkeyRepository.countByUser(userId)).toBe(0)
    })
  })

  describe('rename', () => {
    it('renames the owner passkey', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))

      const renamed = await passkeyRepository.rename(row.id, userId, 'Phone')

      expect(renamed?.name).toBe('Phone')
      const stored = await passkeyRepository.findByCredentialId(row.credentialId)
      expect(stored?.name).toBe('Phone')
    })

    it("returns undefined and changes nothing for another user's passkey", async () => {
      const userId = await createUser()
      const otherId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))

      expect(await passkeyRepository.rename(row.id, otherId, 'Hijacked')).toBeUndefined()
      expect(await passkeyRepository.findByCredentialId(row.credentialId)).toEqual(row)
    })
  })

  describe('deleteForUser', () => {
    it('deletes and returns the owner passkey', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))

      expect(await passkeyRepository.deleteForUser(row.id, userId)).toEqual(row)
      expect(await passkeyRepository.findByCredentialId(row.credentialId)).toBeUndefined()
    })

    it("returns undefined and keeps the row for another user's passkey", async () => {
      const userId = await createUser()
      const otherId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))

      expect(await passkeyRepository.deleteForUser(row.id, otherId)).toBeUndefined()
      expect(await passkeyRepository.findByCredentialId(row.credentialId)).toEqual(row)
    })
  })

  describe('recordUse', () => {
    it('stores the new count, backup state and time', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))
      const at = new Date('2026-10-20T10:00:00.000Z')

      const outcome = await passkeyRepository.recordUse(row.id, userId, {
        signCount: 42,
        backupState: true,
        at,
      })
      expect(outcome).toBe('recorded')

      const found = await passkeyRepository.findByCredentialId(row.credentialId)
      expect(found?.signCount).toBe(42)
      expect(found?.backupState).toBe(true)
      expect(found?.lastUsedAt).toEqual(at)
    })

    it('changes nothing and answers missing for another user, or a row that is gone', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))
      const at = new Date('2026-10-20T10:00:00.000Z')

      const outcomeOther = await passkeyRepository.recordUse(row.id, await createUser(), {
        signCount: 99,
        backupState: true,
        at,
      })
      await passkeyRepository.deleteForUser(row.id, userId)
      const outcomeGone = await passkeyRepository.recordUse(row.id, userId, {
        signCount: 99,
        backupState: true,
        at,
      })

      expect(outcomeOther).toBe('missing')
      expect(outcomeGone).toBe('missing')
    })

    it('refuses a device-bound passkey whose count does not rise, and keeps the stored count', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(
        passkeyFor(userId, { backupEligible: false, signCount: 5 })
      )
      const at = new Date('2026-10-20T10:00:00.000Z')

      const same = await passkeyRepository.recordUse(row.id, userId, {
        signCount: 5,
        backupState: false,
        at,
      })
      const lower = await passkeyRepository.recordUse(row.id, userId, {
        signCount: 3,
        backupState: false,
        at,
      })

      expect(same).toBe('regressed')
      expect(lower).toBe('regressed')
      const kept = await passkeyRepository.findByCredentialId(row.credentialId)
      expect(kept?.signCount).toBe(5)
    })

    it('accepts a count of 0 on a never-counted device-bound passkey, and any count on a synced one', async () => {
      const userId = await createUser()
      const bound = await passkeyRepository.create(
        passkeyFor(userId, { backupEligible: false, signCount: 0 })
      )
      const synced = await passkeyRepository.create(
        passkeyFor(userId, { backupEligible: true, signCount: 9 })
      )
      const at = new Date('2026-10-20T10:00:00.000Z')

      const first = await passkeyRepository.recordUse(bound.id, userId, {
        signCount: 0,
        backupState: false,
        at,
      })
      const copied = await passkeyRepository.recordUse(synced.id, userId, {
        signCount: 9,
        backupState: true,
        at,
      })

      expect(first).toBe('recorded')
      expect(copied).toBe('recorded')
    })

    it('lets exactly one of two parallel uses with the same count win on a device-bound passkey', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(
        passkeyFor(userId, { backupEligible: false, signCount: 5 })
      )
      const use = { signCount: 6, backupState: false, at: new Date('2026-10-20T10:00:00.000Z') }

      const outcomes = await Promise.all([
        passkeyRepository.recordUse(row.id, userId, use),
        passkeyRepository.recordUse(row.id, userId, use),
      ])

      expect(outcomes.toSorted((a, b) => a.localeCompare(b))).toEqual(['recorded', 'regressed'])
    })
  })

  describe('cascade', () => {
    it('deletes passkeys when the user is deleted', async () => {
      const userId = await createUser()
      const row = await passkeyRepository.create(passkeyFor(userId))

      await sql`delete from users where id = ${userId}`

      expect(await passkeyRepository.findByCredentialId(row.credentialId)).toBeUndefined()
    })
  })
})
