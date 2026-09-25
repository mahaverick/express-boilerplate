// tests/integration/scripts/platform-grant.test.ts
//
// runPlatformGrant against the real per-worker Postgres: the exit code and
// what it prints. The grant rules themselves are covered in
// tests/integration/services/platform.service.test.ts.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { runPlatformGrant } from '@/scripts/platform-grant'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'

const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

describe('runPlatformGrant', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await truncateAuditLogs()
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh verified user, tracked for cleanup.
   * @returns Its id and address.
   */
  async function createVerifiedUser(): Promise<{ id: string; email: string }> {
    const user = await userRepository.create({ email: `grant-script-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    return { id: user.id, email: user.email }
  }

  it('grants the role, prints one line and exits 0', async () => {
    const user = await createVerifiedUser()
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runPlatformGrant(['--', user.email, 'owner'])

    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(`Granted owner in the platform tenant to ${user.email}.\n`)
    expect(await userMembershipRepository.findPlatformRole(user.id)).toBe('owner')
  })

  it('exits 1 with the reason for an unknown account', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await runPlatformGrant(['--', `nobody-${randomUUID()}@example.test`, 'owner'])

    expect(code).toBe(1)
    expect(stderr).toHaveBeenCalledWith('No account uses that email address\n')
  })

  it('exits 1 with the reason for an unverified account, granting nothing', async () => {
    const user = await userRepository.create({ email: `grant-script-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runPlatformGrant([user.email, 'admin'])).toBe(1)
    expect(stderr).toHaveBeenCalledWith('That account has not verified its email address\n')
    expect(await userMembershipRepository.findPlatformRole(user.id)).toBeNull()
  })

  it('exits 1 for an unknown role, granting nothing', async () => {
    const user = await createVerifiedUser()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runPlatformGrant(['--', user.email, 'superuser'])).toBe(1)
    expect(await userMembershipRepository.findPlatformRole(user.id)).toBeNull()
  })
})
