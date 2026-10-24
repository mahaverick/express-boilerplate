/**
 * @file The cancel marker's write against this worker's database: it locks
 * the owner's user row before the billing row, in the documented lock
 * order, so a transaction that holds the user and then wants the billing
 * row (a purge of that owner) waits for it instead of deadlocking.
 */
import { sql as drizzleSql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { markCancel } from '@/services/billing/cancel-marker.service'
import { withTransaction } from '@/services/database.service'
import { closeRedis } from '@/services/redis.service'
import {
  deleteTrackedTenants,
  loadPlans,
  makePaying,
  readBilling,
  workspace,
} from '../../../helpers/billing-api'
import { backendPid, waitForWaiter } from '../../../helpers/lock-probe'
import { deleteTrackedUsers } from '../../../helpers/platform-users'

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await closeRedis()
})

describe('markCancel', () => {
  it('waits on the owner row before the billing row, so a user-then-billing transaction never deadlocks with it', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    let marking: Promise<void> | undefined

    await withTransaction(async (tx) => {
      // Lock order: the user row first, then the billing row.
      await tx.execute(drizzleSql`select id from users where id = ${owner.id} for update`)
      marking = markCancel(tenant.id, subscriptionId, { by: 'owner', userId: owner.id })
      const isWaiting = await waitForWaiter(await backendPid(tx), marking)
      expect(isWaiting).toBe(true)
      // With the old order the marker held this row and waited on the user: a deadlock.
      await tx.execute(
        drizzleSql`select tenant_id from tenant_billing where tenant_id = ${tenant.id} for no key update`
      )
    })
    await marking

    expect(await readBilling(tenant.id)).toMatchObject({
      cancelMarkerSubscriptionId: subscriptionId,
      cancelMarkerBy: 'owner',
      cancelMarkerUserId: owner.id,
    })
  })
})
