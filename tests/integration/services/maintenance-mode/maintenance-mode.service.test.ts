/**
 * @file `assertSignInAllowed` against the real platform membership and this
 * process's store, and the Google sign-in it guards: in `full` a non-staff
 * Google user is refused before any session row, and staff get one.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { sql } from '@/services/database.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  assertSignInAllowed,
  getPublicMaintenanceStatus,
} from '@/services/maintenance-mode/maintenance-mode.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import { makeStaff } from '../../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'

/**
 * A verified Google profile for an address.
 * @param email - The address Google reports.
 * @returns The profile.
 */
function googleProfile(email: string): GoogleProfile {
  const id = randomUUID()
  return {
    provider: 'google',
    id,
    displayName: 'Test User',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: 0,
      exp: 0,
      email,
      email_verified: true,
    },
  }
}

/**
 * How many sessions a user holds.
 * @param userId - The user.
 * @returns The count of `user_tokens` rows.
 */
async function sessionsOf(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens where user_id = ${userId}`
  return row?.count ?? 0
}

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  await sql`delete from users where email like 'mm-google-%@example.test'`
  await deleteTrackedUsers()
})

describe('assertSignInAllowed', () => {
  it('lets anyone sign in while off or read_only', async () => {
    const user = await createTrackedUser()
    await expect(assertSignInAllowed(user.id)).resolves.toBeUndefined()
    await storeMaintenanceMode('read_only')
    await reloadMaintenanceMode()
    await expect(assertSignInAllowed(user.id)).resolves.toBeUndefined()
  })

  it('refuses a user with no platform role in full, with the owner message', async () => {
    const user = await createTrackedUser()
    await storeMaintenanceMode('full', { message: 'Back at noon.' })
    await reloadMaintenanceMode()

    let refusal: unknown
    try {
      await assertSignInAllowed(user.id)
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(MaintenanceModeError)
    expect(refusal).toMatchObject({
      statusCode: 503,
      code: 'MAINTENANCE_MODE',
      message: 'Back at noon.',
      mode: 'full',
    })
  })

  it('admits every platform role in full', async () => {
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()
    const { user } = await createTrackedStaff('viewer')

    await expect(assertSignInAllowed(user.id)).resolves.toBeUndefined()
  })
})

describe('Google sign-in in full', () => {
  it('refuses a non-staff Google user before any session is issued', async () => {
    const user = await createTrackedUser({ email: `mm-google-${randomUUID()}@example.test` })
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    await expect(completeGoogleSignIn(googleProfile(user.email))).rejects.toBeInstanceOf(
      MaintenanceModeError
    )
    expect(await sessionsOf(user.id)).toBe(0)
  })

  it('issues staff a session', async () => {
    const user = await createTrackedUser({ email: `mm-google-${randomUUID()}@example.test` })
    await makeStaff(user.id, 'admin')
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    await completeGoogleSignIn(googleProfile(user.email))

    expect(await sessionsOf(user.id)).toBe(1)
  })
})

describe('getPublicMaintenanceStatus', () => {
  it('answers the mode, message and since only', async () => {
    const changedAt = new Date('2026-10-06T10:42:00.000Z')
    await storeMaintenanceMode('read_only', { message: 'Read only.', changedAt })
    await reloadMaintenanceMode()

    expect(getPublicMaintenanceStatus()).toEqual({
      mode: 'read_only',
      message: 'Read only.',
      since: changedAt.toISOString(),
    })
  })
})
