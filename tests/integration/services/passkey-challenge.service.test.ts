/**
 * @file Passkey challenges are single-use, bound to a purpose and a user or
 * session, and expire: a replayed, cross-purpose or lapsed challenge answers
 * `undefined`, and a mismatched read still burns the challenge.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import {
  consumePasskeyChallenge,
  issuePasskeyChallenge,
} from '@/services/passkey-challenge.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { waitUntil } from '../../helpers/timing'

afterAll(async () => {
  await closeRedis()
})

describe('passkey challenges', () => {
  it('issues a 32-byte base64url challenge under a UUID id', async () => {
    const { challengeId, challenge } = await issuePasskeyChallenge('sign_in', {})
    expect(challengeId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/)
    expect(challenge).toMatch(/^[\w-]{43}$/)
    expect(Buffer.from(challenge, 'base64url')).toHaveLength(32)
  })

  it('answers the challenge once, then undefined', async () => {
    const userId = randomUUID()
    const issued = await issuePasskeyChallenge('create', { userId })
    expect(await consumePasskeyChallenge(issued.challengeId, 'create', { userId })).toBe(
      issued.challenge
    )
    expect(await consumePasskeyChallenge(issued.challengeId, 'create', { userId })).toBeUndefined()
  })

  it('answers undefined for an id that was never issued', async () => {
    expect(await consumePasskeyChallenge(randomUUID(), 'sign_in', {})).toBeUndefined()
  })

  it('answers undefined for a wrong purpose and burns the challenge', async () => {
    const issued = await issuePasskeyChallenge('sign_in', {})
    expect(await consumePasskeyChallenge(issued.challengeId, 'step_up', {})).toBeUndefined()
    expect(await consumePasskeyChallenge(issued.challengeId, 'sign_in', {})).toBeUndefined()
  })

  it('answers undefined for a different userId and burns the challenge', async () => {
    const userId = randomUUID()
    const issued = await issuePasskeyChallenge('step_up', { userId })
    expect(
      await consumePasskeyChallenge(issued.challengeId, 'step_up', { userId: randomUUID() })
    ).toBeUndefined()
    expect(await consumePasskeyChallenge(issued.challengeId, 'step_up', { userId })).toBeUndefined()
  })

  it('answers undefined for a different or missing sessionId', async () => {
    const sessionId = randomUUID()
    const first = await issuePasskeyChallenge('step_up', { sessionId })
    expect(
      await consumePasskeyChallenge(first.challengeId, 'step_up', { sessionId: randomUUID() })
    ).toBeUndefined()
    const second = await issuePasskeyChallenge('step_up', { sessionId })
    expect(await consumePasskeyChallenge(second.challengeId, 'step_up', {})).toBeUndefined()
    const third = await issuePasskeyChallenge('sign_in', {})
    expect(
      await consumePasskeyChallenge(third.challengeId, 'sign_in', { sessionId })
    ).toBeUndefined()
  })

  it('answers undefined once the TTL has passed', async () => {
    const issued = await issuePasskeyChallenge('sign_in', {}, { ttlMs: 50 })
    const redis = await getRedis()
    await waitUntil(
      async () => (await redis.exists(redisKey('passkey-challenge', issued.challengeId))) === 0,
      {
        message: 'challenge key expires',
      }
    )
    expect(await consumePasskeyChallenge(issued.challengeId, 'sign_in', {})).toBeUndefined()
  })

  it('answers undefined for a stored value that is not a challenge record', async () => {
    const redis = await getRedis()
    const challengeId = randomUUID()
    await redis.set(redisKey('passkey-challenge', challengeId), 'not json', { PX: 5000 })
    expect(await consumePasskeyChallenge(challengeId, 'sign_in', {})).toBeUndefined()
    expect(await redis.exists(redisKey('passkey-challenge', challengeId))).toBe(0)
  })
})
