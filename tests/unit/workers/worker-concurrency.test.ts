// tests/unit/workers/worker-concurrency.test.ts
//
// Both workers take their concurrency from WORKER_CONCURRENCY. BullMQ's
// Worker is swapped for a recorder and the queue connection for a stub, so
// no Redis is touched; getEnv() is a vi.fn over the real one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'

const { constructed } = vi.hoisted(() => ({
  constructed: [] as { queue: string; concurrency: number | undefined }[],
}))

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>()
  class RecordingWorker {
    constructor(queue: string, _processor: unknown, options: { concurrency?: number }) {
      constructed.push({ queue, concurrency: options.concurrency })
    }

    on(): this {
      return this
    }
  }
  return { ...actual, Worker: RecordingWorker }
})

vi.mock('@/services/queue.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/queue.service')>()
  return { ...actual, getQueueConnection: vi.fn(() => ({})) }
})

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

const realEnv = getEnv()

afterEach(() => {
  vi.mocked(getEnv).mockReturnValue(realEnv)
  constructed.length = 0
})

describe('worker concurrency', () => {
  it('starts the email and notification workers with WORKER_CONCURRENCY', () => {
    vi.mocked(getEnv).mockReturnValue({ ...realEnv, WORKER_CONCURRENCY: 7 })

    startEmailWorker()
    startNotificationWorker()

    expect(constructed).toEqual([
      { queue: 'email', concurrency: 7 },
      { queue: 'notification', concurrency: 7 },
    ])
  })
})
