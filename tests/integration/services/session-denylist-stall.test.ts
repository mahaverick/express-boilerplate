/**
 * @file A logout while Redis is connected but does not answer: the request
 * is not held past the deadline, and the deny still lands once Redis
 * answers, so the session's access tokens stop working then. The stall is
 * the real shared client's `set` held back by a gate (`withMutatedMethod`);
 * nothing under `src/` changes.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resetRedisDeadlineForTests, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { issueRefreshToken, revokeRefreshToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'
import { waitUntil } from '../../helpers/timing'

afterEach(async () => {
  resetRedisDeadlineForTests()
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

describe('the session deny through a stalled Redis', () => {
  it('lets a logout answer within the deadline and still denies the session once Redis answers', async () => {
    const user = await createTrackedUser()
    const sessionId = randomUUID()
    const { raw } = await issueRefreshToken(user.id, sessionId)
    const client = await getRedis()
    const realSet = client.set.bind(client)
    const gate = { open: () => {} }
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve
    })

    await withMutatedMethod(
      client,
      'set',
      async (...parameters: Parameters<typeof client.set>) => {
        await opened
        return realSet(...parameters)
      },
      async () => {
        expect(await answerWithinBound(revokeRefreshToken(raw))).not.toBe('hung')
        expect(await isSessionDenied(sessionId)).toBe(false)

        gate.open()
        await waitUntil(() => isSessionDenied(sessionId), {
          message: 'the deny lands once Redis answers',
        })
      }
    )
  })

  it('writes the deny at once while a stall cooldown is open', async () => {
    await expect(withRedisDeadline(stalledCommand, 'stall')).rejects.toThrow()
    const user = await createTrackedUser()
    const sessionId = randomUUID()
    const { raw } = await issueRefreshToken(user.id, sessionId)

    await revokeRefreshToken(raw)

    // Read past the cooldown: isSessionDenied fails open while it lasts.
    const client = await getRedis()
    expect(await client.exists(redisKey('denylist', 'session', sessionId))).toBe(1)
  })
})
