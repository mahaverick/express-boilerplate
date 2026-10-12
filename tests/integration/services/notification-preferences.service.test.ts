/**
 * @file `updatePreferences` writes its entries in one transaction: when a later entry is refused
 * by the repository guard (reachable only by calling the service directly, past the validator),
 * the earlier entry is rolled back with it.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { updatePreferences } from '@/services/notification.service'

const userRepository = new UserRepository()

describe('updatePreferences', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  it('rolls back an earlier valid entry when a later one is refused', async () => {
    const user = await userRepository.create({ email: `pref-service-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)

    await expect(
      updatePreferences(user.id, [
        { notificationType: 'verify_email', emailEnabled: true, inAppEnabled: false },
        { notificationType: 'password_changed', emailEnabled: false, inAppEnabled: true },
      ])
    ).rejects.toMatchObject({ statusCode: 400 })

    const rows = await sql`select * from notification_preferences where user_id = ${user.id}`
    expect(rows).toHaveLength(0)
  })

  it('writes every entry when all are valid', async () => {
    const user = await userRepository.create({ email: `pref-service-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)

    const rows = await updatePreferences(user.id, [
      { notificationType: 'verify_email', emailEnabled: true, inAppEnabled: false },
      { notificationType: 'password_changed', emailEnabled: true, inAppEnabled: false },
    ])

    expect(rows).toHaveLength(2)
  })
})
