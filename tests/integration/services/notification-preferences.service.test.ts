/**
 * @file `updatePreferences` writes its entries in one transaction: when a later entry is refused
 * by the repository guard (reachable only by calling the service directly, past the validator),
 * the earlier entry is rolled back with it. Two concurrent updates for one user that list the same
 * types in opposite orders both succeed.
 */
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { updatePreferences } from '@/services/notification.service'
import { pollUntil } from '../../helpers/lock-probe'

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

  it('writes every entry when all are valid, answering in the order given', async () => {
    const user = await userRepository.create({ email: `pref-service-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)

    // Listed against `NOTIFICATION_TYPES` order, which the writes follow: the rows still come back as listed.
    const rows = await updatePreferences(user.id, [
      { notificationType: 'password_changed', emailEnabled: true, inAppEnabled: false },
      { notificationType: 'verify_email', emailEnabled: true, inAppEnabled: false },
    ])

    expect(rows.map((row) => row.notificationType)).toEqual(['password_changed', 'verify_email'])
  })

  it('lets two concurrent updates that list the same types in opposite orders both succeed', async () => {
    const user = await userRepository.create({ email: `pref-service-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    const enabled = { emailEnabled: true, inAppEnabled: true }
    const disabled = { emailEnabled: true, inAppEnabled: false }
    await updatePreferences(user.id, [
      { notificationType: 'verify_email', ...enabled },
      { notificationType: 'password_changed', ...enabled },
    ])

    // A dedicated connection: the two updates hold both pool connections (`DB_POOL_MAX=2`).
    const holder = postgres(getEnv().DATABASE_URL, { max: 1 })
    try {
      const { updates } = await holder.begin(async (tx) => {
        // Both rows held, so each update queues on its first row and none takes a lock before the other starts.
        const [{ pid } = { pid: 0 }] = await tx<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `
        await tx`
          select 1 from notification_preferences
          where user_id = ${user.id} for no key update
        `
        const updates = Promise.allSettled([
          updatePreferences(user.id, [
            { notificationType: 'verify_email', ...disabled },
            { notificationType: 'password_changed', ...disabled },
          ]),
          updatePreferences(user.id, [
            { notificationType: 'password_changed', ...disabled },
            { notificationType: 'verify_email', ...disabled },
          ]),
        ])
        const isQueued = await pollUntil(
          async (probe) => {
            // A second waiter on the same row queues behind the first, not the holder, so count every waiter in this database.
            const [row] = await probe<{ waiters: number }[]>`
              select count(*)::int as waiters from pg_stat_activity
              where datname = current_database() and pid <> ${pid}::int
                and cardinality(pg_blocking_pids(pid)) > 0
            `
            return (row?.waiters ?? 0) >= 2
          },
          updates,
          5000,
          'both updates queued behind the held rows'
        )
        expect(isQueued).toBe(true)
        // Wrapped, not returned bare: `begin` would await the updates before committing, and they wait on this commit.
        return { updates }
      })

      const [first, second] = await updates
      // A refusal shows its SQLSTATE (40P01 for a deadlock), the driver error or the query error's cause.
      const outcomes = [first, second].map((result) =>
        result?.status === 'rejected'
          ? String(
              (result.reason as { code?: unknown; cause?: { code?: unknown } }).cause?.code ??
                (result.reason as { code?: unknown }).code ??
                result.reason
            )
          : result?.status
      )
      expect(outcomes).toEqual(['fulfilled', 'fulfilled'])
      if (first?.status !== 'fulfilled' || second?.status !== 'fulfilled') return
      expect(first.value.map((row) => row.notificationType)).toEqual([
        'verify_email',
        'password_changed',
      ])
      expect(second.value.map((row) => row.notificationType)).toEqual([
        'password_changed',
        'verify_email',
      ])
    } finally {
      await holder.end({ timeout: 5 })
    }
  })
})
