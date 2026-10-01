/**
 * @file EmailSuppressionRepository against the real per-worker Postgres:
 * one active suppression per address in any case, and lifting.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import { sql } from '@/services/database.service'

const repository = new EmailSuppressionRepository()
const createdAddresses: string[] = []

afterEach(async () => {
  if (createdAddresses.length === 0) return
  await sql`delete from email_suppressions where address = any(${createdAddresses})`
  createdAddresses.length = 0
})

/**
 * A fresh address in mixed case, tracked (lowercased) for cleanup.
 * @returns The mixed-case address.
 */
function uniqueAddress(): string {
  const address = `Suppressed-${randomUUID()}@Example.test`
  createdAddresses.push(address.toLowerCase())
  return address
}

describe('EmailSuppressionRepository', () => {
  it('stores the address lowercased and finds it in any case', async () => {
    const address = uniqueAddress()
    const created = await repository.suppress({
      address,
      reason: 'hard_bounce',
    })
    expect(created?.address).toBe(address.toLowerCase())
    await expect(repository.findActive(address.toUpperCase())).resolves.toMatchObject({
      id: created?.id,
    })
  })

  it('writes nothing for an address that is already suppressed', async () => {
    const address = uniqueAddress()
    await repository.suppress({ address, reason: 'hard_bounce' })
    await expect(repository.suppress({ address, reason: 'complaint' })).resolves.toBeUndefined()
    const rows = await sql<
      { reason: string }[]
    >`select reason from email_suppressions where address = ${address.toLowerCase()}`
    expect(rows.map((row) => row.reason)).toEqual(['hard_bounce'])
  })

  it('lifts an active suppression once, with who and why', async () => {
    const address = uniqueAddress()
    const created = await repository.suppress({
      address,
      reason: 'complaint',
    })
    const id = created?.id ?? ''
    const lifted = await repository.lift(id, { liftedBy: 'staff-1', liftReason: 'Fixed' })
    expect(lifted).toMatchObject({ id, liftedBy: 'staff-1', liftReason: 'Fixed' })
    expect(lifted?.liftedAt).toBeInstanceOf(Date)
    await expect(repository.findActive(address)).resolves.toBeUndefined()
    await expect(
      repository.lift(id, { liftedBy: 'staff-2', liftReason: 'Again' })
    ).resolves.toBeUndefined()
  })

  it('suppresses an address again after a lift', async () => {
    const address = uniqueAddress()
    const first = await repository.suppress({
      address,
      reason: 'hard_bounce',
    })
    await repository.lift(first?.id ?? '', { liftedBy: 'staff-1', liftReason: 'Fixed' })
    const second = await repository.suppress({
      address,
      reason: 'hard_bounce',
    })
    expect(second).toBeDefined()
    expect(second?.id).not.toBe(first?.id)
  })
})
