/**
 * @file Exercises `runPlatformGrant` against the real per-worker Postgres:
 * the exit code and what it prints. The grant rules themselves are covered
 * in `tests/integration/services/platform.service.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
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
   * Creates a user with a verified email, tracked for cleanup.
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

  it('creates a verified account for an unknown address, grants the role and exits 0', async () => {
    const email = `grant-script-new-${randomUUID()}@example.test`
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runPlatformGrant(['--', email, 'owner'])

    const [created] = await sql<{ id: string; verified: boolean }[]>`
      select id, email_verified_at is not null as verified from users where email = ${email}`
    createdUserIds.push(created?.id ?? '')
    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(`Granted owner in the platform tenant to ${email}.\n`)
    expect(created?.verified).toBe(true)
    expect(await userMembershipRepository.findPlatformRole(created?.id ?? '')).toBe('owner')
  })

  it('verifies an unverified account, grants the role and exits 0', async () => {
    const user = await userRepository.create({ email: `grant-script-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(await runPlatformGrant([user.email, 'admin'])).toBe(0)
    expect(await userMembershipRepository.findPlatformRole(user.id)).toBe('admin')
    const [row] = await sql<{ verified: boolean }[]>`
      select email_verified_at is not null as verified from users where id = ${user.id}`
    expect(row?.verified).toBe(true)
  })

  it('exits 1 for an unknown role, granting nothing', async () => {
    const user = await createVerifiedUser()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runPlatformGrant(['--', user.email, 'superuser'])).toBe(1)
    expect(await userMembershipRepository.findPlatformRole(user.id)).toBeNull()
  })
})
