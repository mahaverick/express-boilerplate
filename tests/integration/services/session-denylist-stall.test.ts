/**
 * @file A logout while Redis is connected but does not answer: the request
 * is not held past the deadline, and the deny still lands once Redis
 * answers, so the session's access tokens stop working then. The stall is
 * the real shared client's `set` held back by a gate (`withMutatedMethod`);
 * nothing under `src/` changes.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/services/logger.service'
import { resetRedisDeadlineForTests, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import {
  issueRefreshToken,
  revokeAllSessions,
  revokeRefreshToken,
} from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'
import { waitUntil } from '../../helpers/timing'

afterEach(async () => {
  vi.restoreAllMocks()
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

  it('logs a revoke-all deny that fails at once with the revocation error line and the user id', async () => {
    const user = await createTrackedUser()
    await issueRefreshToken(user.id, randomUUID())
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const client = await getRedis()

    await withMutatedMethod(
      client,
      'set',
      () => Promise.reject(new Error('connection reset')),
      async () => {
        await revokeAllSessions(user.id)
      }
    )

    expect(error).toHaveBeenCalledWith(
      'session denylist write failed after revocation',
      expect.objectContaining({ userId: user.id, sessionCount: 1 })
    )
  })

  it('logs a revoke-all deny that fails after the deadline with the user id', async () => {
    const user = await createTrackedUser()
    await issueRefreshToken(user.id, randomUUID())
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const client = await getRedis()
    const gate = { fail: () => {} }
    const failed = new Promise<never>((_resolve, reject) => {
      gate.fail = () => {
        reject(new Error('connection reset'))
      }
    })

    await withMutatedMethod(
      client,
      'set',
      () => failed,
      async () => {
        expect(await answerWithinBound(revokeAllSessions(user.id))).not.toBe('hung')
        gate.fail()
        await waitUntil(() => error.mock.calls.length > 0, {
          message: 'the late failure is logged',
        })
      }
    )

    expect(error).toHaveBeenCalledWith(
      'session denylist write failed after revocation',
      expect.objectContaining({ userId: user.id, sessionCount: 1 })
    )
  })
})
