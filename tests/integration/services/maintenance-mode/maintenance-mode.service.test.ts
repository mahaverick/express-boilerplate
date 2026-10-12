/**
 * @file `assertSignInAllowed` against the real platform membership and this
 * process's store, and the Google sign-in it guards: in `full` a non-staff
 * Google sign-in is refused before anything is written (no account created,
 * linked or claimed, no session revoked or issued), and staff get a session.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { sql } from '@/services/database.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  assertSignInAllowed,
  getMaintenanceModeStatus,
  getPublicMaintenanceStatus,
} from '@/services/maintenance-mode/maintenance-mode.service'
import { issueRefreshToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import { makeStaff } from '../../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'

/**
 * Builds a Google profile for `email` with a fresh Google id, reported
 * verified unless `isVerified` is false; `email` undefined carries no email claim.
 */
function googleProfile(email: string | undefined, isVerified = true): GoogleProfile {
  const id = randomUUID()
  return {
    provider: 'google',
    id,
    displayName: 'Test User',
    profileUrl: `https://plus.google.com/${id}`,
    ...(email !== undefined && { emails: [{ value: email, verified: isVerified }] }),
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: 0,
      exp: 0,
      ...(email !== undefined && { email, email_verified: isVerified }),
    },
  }
}

/**
 * A fresh address the `afterEach` cleanup matches.
 */
function googleEmail(): string {
  return `mm-google-${randomUUID()}@example.test`
}

/**
 * Counts the `google` `auth_providers` rows for a Google id, or for a user.
 */
async function googleLinks(by: { providerId: string } | { userId: string }): Promise<number> {
  const [row] =
    'providerId' in by
      ? await sql<{ count: number }[]>`
          select count(*)::int as count from auth_providers
          where provider = 'google' and provider_id = ${by.providerId}`
      : await sql<{ count: number }[]>`
          select count(*)::int as count from auth_providers
          where provider = 'google' and user_id = ${by.userId}`
  return row?.count ?? 0
}

/**
 * Switches this process to `full`.
 */
async function enterFull(): Promise<void> {
  await storeMaintenanceMode('full')
  await reloadMaintenanceMode()
}

/**
 * Counts a user's `user_tokens` rows, zero after a refused sign-in, one after an allowed one.
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

  it('lets a sign-in that matches no account through while off or read_only', async () => {
    await expect(assertSignInAllowed(undefined)).resolves.toBeUndefined()
    await storeMaintenanceMode('read_only')
    await reloadMaintenanceMode()
    await expect(assertSignInAllowed(undefined)).resolves.toBeUndefined()
  })

  it('refuses a sign-in that matches no account in full', async () => {
    await enterFull()

    await expect(assertSignInAllowed(undefined)).rejects.toBeInstanceOf(MaintenanceModeError)
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

  it('refuses a Google profile with no account, and creates nothing', async () => {
    const email = googleEmail()
    const profile = googleProfile(email)
    await enterFull()

    await expect(completeGoogleSignIn(profile)).rejects.toBeInstanceOf(MaintenanceModeError)

    const [users] = await sql<{ count: number }[]>`
      select count(*)::int as count from users where email = ${email}`
    expect(users?.count).toBe(0)
    expect(await googleLinks({ providerId: profile.id })).toBe(0)
  })

  it('refuses a non-staff, verified account before linking it', async () => {
    const user = await createTrackedUser({ email: googleEmail() })
    await enterFull()

    await expect(completeGoogleSignIn(googleProfile(user.email))).rejects.toBeInstanceOf(
      MaintenanceModeError
    )

    expect(await googleLinks({ userId: user.id })).toBe(0)
  })

  it('refuses a non-staff, never-verified account before claiming it', async () => {
    const user = await createTrackedUser({
      email: googleEmail(),
      verified: false,
      hasPassword: true,
    })
    await issueRefreshToken(user.id, randomUUID())
    await enterFull()

    await expect(completeGoogleSignIn(googleProfile(user.email))).rejects.toBeInstanceOf(
      MaintenanceModeError
    )

    const [row] = await sql<{ hasPassword: boolean; isUnverified: boolean }[]>`
      select password_hash is not null as "hasPassword", email_verified_at is null as "isUnverified"
      from users where id = ${user.id}`
    expect(row).toEqual({ hasPassword: true, isUnverified: true })
    expect(await googleLinks({ userId: user.id })).toBe(0)
    const [tokens] = await sql<{ live: number }[]>`
      select count(*)::int as live from user_tokens
      where user_id = ${user.id} and revoked_at is null`
    expect(tokens?.live).toBe(1)
  })

  it('answers a non-staff profile with no email with the 503, not a 400', async () => {
    await enterFull()

    await expect(completeGoogleSignIn(googleProfile(undefined))).rejects.toBeInstanceOf(
      MaintenanceModeError
    )
  })

  it('issues staff a session through an existing Google link', async () => {
    const user = await createTrackedUser({ email: googleEmail() })
    await makeStaff(user.id, 'viewer')
    // Google now reports another address: only the link can find this account.
    const profile = googleProfile(googleEmail())
    await new AuthProviderRepository().create({
      userId: user.id,
      provider: 'google',
      providerId: profile.id,
    })
    await enterFull()

    await completeGoogleSignIn(profile)

    expect(await sessionsOf(user.id)).toBe(1)
  })

  it('still refuses staff whose Google email is unverified, and links nothing', async () => {
    const user = await createTrackedUser({ email: googleEmail() })
    await makeStaff(user.id, 'admin')
    await enterFull()

    let refusal: unknown
    try {
      await completeGoogleSignIn(googleProfile(user.email, false))
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(HttpError)
    expect(refusal).toMatchObject({ statusCode: 403, code: 'email_not_verified' })
    expect(await googleLinks({ userId: user.id })).toBe(0)
    expect(await sessionsOf(user.id)).toBe(0)
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

describe('getMaintenanceModeStatus', () => {
  it('carries the last change time even while off, where since is null', async () => {
    const switchedOff = new Date('2026-10-07T09:30:00.000Z')
    await storeMaintenanceMode('off', { changedAt: switchedOff })
    await reloadMaintenanceMode()

    const status = await getMaintenanceModeStatus()

    expect(status).toMatchObject({
      mode: 'off',
      // eslint-disable-next-line unicorn/no-null -- the status's contract is null while off
      since: null,
      changedAt: '2026-10-07T09:30:00.000Z',
    })
  })

  it('carries the same time as since while a mode is on', async () => {
    const switchedOn = new Date('2026-10-07T09:00:00.000Z')
    await storeMaintenanceMode('read_only', { changedAt: switchedOn })
    await reloadMaintenanceMode()

    expect(await getMaintenanceModeStatus()).toMatchObject({
      mode: 'read_only',
      since: '2026-10-07T09:00:00.000Z',
      changedAt: '2026-10-07T09:00:00.000Z',
    })
  })
})
