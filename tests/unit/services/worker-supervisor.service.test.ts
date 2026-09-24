// tests/unit/services/worker-supervisor.service.test.ts
//
// The supervisor's replacement rules, with the Workers and the queue module
// mocked. The real outage path is tests/integration/workers/worker-outage.test.ts.
import type { Worker } from 'bullmq'
import type IORedis from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markShuttingDown, resetLifecycleForTests } from '@/services/lifecycle.service'
import {
  getQueueConnection,
  onWorkerConnectionLost,
  setWorkersFailed,
} from '@/services/queue.service'
import { startWorkers } from '@/services/worker-supervisor.service'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'

vi.mock('@/services/queue.service', () => ({
  getQueueConnection: vi.fn(),
  onWorkerConnectionLost: vi.fn(),
  setWorkersFailed: vi.fn(),
}))
vi.mock('@/workers/email.worker', () => ({ startEmailWorker: vi.fn() }))
vi.mock('@/workers/notification.worker', () => ({ startNotificationWorker: vi.fn() }))

interface FakeWorker {
  close: ReturnType<typeof vi.fn>
}

/**
 * A Worker stand-in whose close() resolves once `release` is called.
 * @returns The fake, and a function that lets its close() resolve.
 */
function fakeWorker(): { worker: FakeWorker; release: () => void } {
  const gate = { open: (): void => undefined }
  const released = new Promise<void>((resolve) => {
    gate.open = resolve
  })
  return {
    worker: { close: vi.fn(async () => released) },
    release: () => gate.open(),
  }
}

/**
 * Wire the mocks: each generation gets its own connection and two fake Workers.
 * @returns The fakes in start order, the connections, and the lost-connection listener.
 */
function wireMocks(): {
  workers: ReturnType<typeof fakeWorker>[]
  connections: IORedis[]
  lose: (dead: IORedis) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const workers: ReturnType<typeof fakeWorker>[] = []
  const connections: IORedis[] = []
  const unsubscribe = vi.fn()
  const listeners: ((dead: IORedis) => void)[] = []
  vi.mocked(getQueueConnection).mockImplementation(() => {
    const connection = { id: connections.length } as unknown as IORedis
    connections.push(connection)
    return connection
  })
  const start = (): Worker => {
    const fake = fakeWorker()
    workers.push(fake)
    return fake.worker as unknown as Worker
  }
  vi.mocked(startEmailWorker).mockImplementation(start)
  vi.mocked(startNotificationWorker).mockImplementation(start)
  vi.mocked(onWorkerConnectionLost).mockImplementation((listener) => {
    listeners.push(listener)
    return unsubscribe
  })
  return {
    workers,
    connections,
    lose: (dead) => {
      for (const listener of listeners) listener(dead)
    },
    unsubscribe,
  }
}

describe('startWorkers', () => {
  afterEach(() => {
    resetLifecycleForTests()
    vi.clearAllMocks()
  })

  it('closes the lost Workers within the same call and starts new ones on a new connection', () => {
    const mocks = wireMocks()
    startWorkers()
    expect(mocks.workers).toHaveLength(2)

    mocks.lose(mocks.connections[0] as IORedis)
    // Synchronous: a Worker left running until a later tick would already be spinning.
    for (const { worker } of mocks.workers.slice(0, 2))
      expect(worker.close).toHaveBeenCalledWith(true)
    expect(mocks.workers).toHaveLength(4)
    expect(mocks.connections).toHaveLength(2)
  })

  it('ignores a lost connection its current Workers do not run on', () => {
    const mocks = wireMocks()
    startWorkers()
    mocks.lose({} as IORedis)
    expect(mocks.workers).toHaveLength(2)
    for (const { worker } of mocks.workers) expect(worker.close).not.toHaveBeenCalled()
  })

  it('closes the lost Workers but starts none once shutdown has begun', () => {
    const mocks = wireMocks()
    startWorkers()
    markShuttingDown()
    mocks.lose(mocks.connections[0] as IORedis)
    for (const { worker } of mocks.workers) expect(worker.close).toHaveBeenCalledWith(true)
    expect(mocks.workers).toHaveLength(2)
  })

  it('close() closes the current Workers, waits for lost ones still closing, and stops replacing', async () => {
    const mocks = wireMocks()
    const supervised = startWorkers()
    mocks.lose(mocks.connections[0] as IORedis)
    const [lostEmail, lostNotification, email, notification] = mocks.workers
    if (!lostEmail || !lostNotification || !email || !notification) throw new Error('expected 4')
    email.release()
    notification.release()
    lostNotification.release()

    const outcome = { hasClosed: false }
    const closing = (async () => {
      await supervised.close()
      outcome.hasClosed = true
    })()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(email.worker.close).toHaveBeenCalledWith()
    expect(notification.worker.close).toHaveBeenCalledWith()
    await new Promise((resolve) => setImmediate(resolve))
    expect(outcome.hasClosed).toBe(false)

    lostEmail.release()
    await closing
    expect(outcome.hasClosed).toBe(true)

    mocks.lose(mocks.connections[1] as IORedis)
    expect(mocks.workers).toHaveLength(4)
  })

  it('closes a half-started generation and keeps readiness red, then retries on its next lost connection', () => {
    const mocks = wireMocks()
    startWorkers()
    expect(setWorkersFailed).not.toHaveBeenCalled()

    vi.mocked(startNotificationWorker).mockImplementationOnce(() => {
      throw new Error('Worker constructor failed')
    })
    mocks.lose(mocks.connections[0] as IORedis)
    // The email Worker of the failed generation started, and is closed again.
    const halfStarted = mocks.workers[2]
    expect(mocks.workers).toHaveLength(3)
    expect(halfStarted?.worker.close).toHaveBeenCalledWith(true)
    expect(setWorkersFailed).toHaveBeenLastCalledWith(true)

    // Its connection is still the one watched: losing it starts a full generation.
    mocks.lose(mocks.connections[1] as IORedis)
    expect(mocks.workers).toHaveLength(5)
    expect(setWorkersFailed).toHaveBeenLastCalledWith(false)
  })

  it('throws when the first start fails, after closing any Worker it started, so boot fails fast', () => {
    const mocks = wireMocks()
    vi.mocked(startNotificationWorker).mockImplementationOnce(() => {
      throw new Error('Worker constructor failed')
    })
    expect(() => startWorkers()).toThrow('Worker constructor failed')
    expect(mocks.workers).toHaveLength(1)
    expect(mocks.workers[0]?.worker.close).toHaveBeenCalledWith(true)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
    expect(onWorkerConnectionLost).not.toHaveBeenCalled()
  })
})
