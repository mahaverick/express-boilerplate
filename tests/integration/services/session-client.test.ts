/**
 * @file Refresh rows record the client that holds them, and rotation keeps a
 * browser's session and a native app's apart. Every rotation and grace
 * sibling copies `client` and `device_name` forward; a token presented by the
 * other kind of client answers the unknown-token 401 and spends nothing; and
 * `user_tokens_shape_check` refuses a refresh row with no client and a link
 * row with one, proven by raw inserts.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import {
  hashToken,
  issueRefreshToken,
  rotateRefreshToken,
  type SessionClient,
} from '@/services/session.service'
import { isTokenRowLive } from '../../helpers/grace-sibling'
import { WEB_CLIENT } from '../../helpers/session-client'

const userRepository = new UserRepository()
const createdUserIds: string[] = []
const PHONE: SessionClient = { kind: 'native', deviceName: "Ada's iPhone" }
const UNKNOWN_SESSION = {
  statusCode: 401,
  message: "We don't recognize this session. Sign in again to continue.",
}
const SQL_NULL = null

afterEach(async () => {
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * Creates a user for one test, tracked for cleanup.
 */
async function createUser(): Promise<User> {
  const user = await userRepository.create({
    email: `session-client-${randomUUID()}@example.test`,
  })
  createdUserIds.push(user.id)
  return user
}

/**
 * Reads the client columns and the spend state of the row a raw token hashes to.
 */
async function rowOf(raw: string): Promise<{
  client: string | null
  device_name: string | null
  revoked_at: Date | null
  consumed_at: Date | null
}> {
  const [row] = await sql<
    {
      client: string | null
      device_name: string | null
      revoked_at: Date | null
      consumed_at: Date | null
    }[]
  >`
    select client, device_name, revoked_at, consumed_at from user_tokens
    where token_hash = ${hashToken(raw)}`
  if (!row) throw new Error('rowOf: no row for that token')
  return row
}

/**
 * Inserts one `user_tokens` row with raw SQL, so the database's check, not
 * the application's, decides. Every column but `client` makes a valid row
 * of `purpose`.
 */
async function insertRaw(
  purpose: 'refresh' | 'sign_in_link',
  userId: string,
  client: string | null
): Promise<void> {
  const isRefresh = purpose === 'refresh'
  await sql`
    insert into user_tokens (purpose, user_id, session_id, email, app, client, token_hash, expires_at)
    values (
      ${purpose}, ${isRefresh ? userId : SQL_NULL}, ${isRefresh ? randomUUID() : SQL_NULL},
      ${isRefresh ? SQL_NULL : `session-client-${randomUUID()}@example.test`},
      ${isRefresh ? SQL_NULL : 'web'}, ${client},
      ${randomBytes(32).toString('hex')}, now() + interval '15 minutes'
    )`
}

describe('refresh rows record their client', () => {
  it('a rotation copies client and deviceName to the new row', async () => {
    const user = await createUser()
    const first = await issueRefreshToken(user.id, randomUUID(), undefined, { client: PHONE })

    const rotated = await rotateRefreshToken(first.raw, 'native')

    expect(await rowOf(first.raw)).toMatchObject({ client: 'native', device_name: "Ada's iPhone" })
    expect(await rowOf(rotated.raw)).toMatchObject({
      client: 'native',
      device_name: "Ada's iPhone",
    })
  })

  it('a grace sibling copies client and deviceName', async () => {
    const user = await createUser()
    const first = await issueRefreshToken(user.id, randomUUID(), undefined, { client: PHONE })
    const head = await rotateRefreshToken(first.raw, 'native')

    // Replayed at once, inside REFRESH_REUSE_GRACE_MS of the rotation above.
    const sibling = await rotateRefreshToken(first.raw, 'native')

    expect(sibling.sessionId).toBe(head.sessionId)
    expect(sibling.raw).not.toBe(head.raw)
    expect(await rowOf(sibling.raw)).toMatchObject({
      client: 'native',
      device_name: "Ada's iPhone",
    })
  })

  it('a native replay within 10 s gets a sibling, not a revoke', async () => {
    const user = await createUser()
    const sessionId = randomUUID()
    const first = await issueRefreshToken(user.id, sessionId, undefined, { client: PHONE })
    const head = await rotateRefreshToken(first.raw, 'native')

    await expect(rotateRefreshToken(first.raw, 'native')).resolves.toMatchObject({ sessionId })

    expect(await isTokenRowLive(head.raw)).toBe(true)
    expect(await isSessionDenied(sessionId)).toBe(false)
  })
})

describe('rotation refuses a token presented by the other kind of client', () => {
  it('rotating a web row as native answers 401 and consumes nothing', async () => {
    const user = await createUser()
    const issued = await issueRefreshToken(user.id, randomUUID(), undefined, { client: WEB_CLIENT })

    await expect(rotateRefreshToken(issued.raw, 'native')).rejects.toMatchObject(UNKNOWN_SESSION)

    expect(await rowOf(issued.raw)).toMatchObject({ revoked_at: null, consumed_at: null })
    await expect(rotateRefreshToken(issued.raw, 'web')).resolves.toMatchObject({
      sessionId: issued.sessionId,
    })
  })

  it('rotating a native row as web answers 401 and consumes nothing', async () => {
    const user = await createUser()
    const issued = await issueRefreshToken(user.id, randomUUID(), undefined, { client: PHONE })

    await expect(rotateRefreshToken(issued.raw, 'web')).rejects.toMatchObject(UNKNOWN_SESSION)

    expect(await rowOf(issued.raw)).toMatchObject({ revoked_at: null, consumed_at: null })
    await expect(rotateRefreshToken(issued.raw, 'native')).resolves.toMatchObject({
      sessionId: issued.sessionId,
    })
  })

  it('a spent token presented by the other kind answers the unknown 401 and kills nothing', async () => {
    const user = await createUser()
    const sessionId = randomUUID()
    const first = await issueRefreshToken(user.id, sessionId, undefined, { client: WEB_CLIENT })
    const head = await rotateRefreshToken(first.raw, 'web')
    // Past REFRESH_REUSE_GRACE_MS, so the same replay as 'web' would be reuse and kill the session.
    await sql`
      update user_tokens set consumed_at = consumed_at - interval '11 seconds'
      where token_hash = ${hashToken(first.raw)}`

    await expect(rotateRefreshToken(first.raw, 'native')).rejects.toMatchObject(UNKNOWN_SESSION)

    expect(await isTokenRowLive(head.raw)).toBe(true)
    expect(await isSessionDenied(sessionId)).toBe(false)
  })
})

describe('user_tokens_shape_check and the client', () => {
  const SHAPE = { code: '23514', constraint_name: 'user_tokens_shape_check' }

  it('the shape check refuses a refresh row with no client', async () => {
    const user = await createUser()
    await expect(insertRaw('refresh', user.id, SQL_NULL)).rejects.toMatchObject(SHAPE)
  })

  it('the shape check refuses a sign_in_link row with a client', async () => {
    const user = await createUser()
    await expect(insertRaw('sign_in_link', user.id, 'web')).rejects.toMatchObject(SHAPE)
  })
})
