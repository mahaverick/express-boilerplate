// src/services/worker-supervisor.service.ts
//
// Starts the email and notification Workers and keeps them on a live
// connection. A Worker whose connection gave up before its first 'ready'
// never recovers: BullMQ's own init has rejected for good, and unless that
// error is one BullMQ counts as a connection error (ECONNREFUSED, or
// "Connection is closed.") its fetch loop retries with no delay and starves
// the event loop. So when that connection ends, the supervisor closes those
// Workers at once and starts new ones on a fresh connection. While Redis
// stays down this repeats on each connection's pre-ready give-up, at least
// ~1.2s apart (longer when connects time out).
import type { Worker } from 'bullmq'
import type IORedis from 'ioredis'
import { isShuttingDown } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import {
  getQueueConnection,
  onWorkerConnectionLost,
  setWorkersFailed,
} from '@/services/queue.service'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'

/**
 * The running Workers, as graceful shutdown sees them.
 */
export interface SupervisedWorkers {
  /**
   * Stop replacing Workers, then close the current ones and any still closing.
   */
  close: () => Promise<void>
}

interface WorkerGeneration {
  connection: IORedis | undefined
  workers: Worker[]
}

/**
 * Close Workers without waiting for their jobs, logging any failure.
 * @param workers - Workers being discarded: their connection ended, or their generation failed to start.
 * @returns Resolves once all have closed or failed to.
 */
async function closeLostWorkers(workers: Worker[]): Promise<void> {
  const results = await Promise.allSettled(workers.map((worker) => worker.close(true)))
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Closing a Worker on a lost connection failed', { error: result.reason })
    }
  }
}

/**
 * Start the email and notification Workers, replacing them whenever their connection gives up before its first ready.
 * @returns A handle whose `close()` closes whichever Workers are current.
 * @throws {Error} Whatever starting a Worker throws at first start, after closing any already started.
 */
export function startWorkers(): SupervisedWorkers {
  const supervisor: { generation: WorkerGeneration; isClosed: boolean } = {
    generation: { connection: undefined, workers: [] },
    isClosed: false,
  }
  const retiring = new Set<Promise<void>>()

  const retire = (workers: Worker[]): void => {
    const closing = closeLostWorkers(workers)
    retiring.add(closing)
    void closing.finally(() => retiring.delete(closing))
  }

  // Starts both Workers on the shared connection. A throw part-way closes
  // the ones already started, then propagates.
  const startGeneration = (): void => {
    const generation: WorkerGeneration = { connection: undefined, workers: [] }
    supervisor.generation = generation
    try {
      generation.connection = getQueueConnection()
      // One at a time, so a throw leaves the ones already started in `workers`.
      for (const start of [startEmailWorker, startNotificationWorker]) {
        generation.workers.push(start())
      }
    } catch (error) {
      retire(generation.workers)
      generation.workers = []
      throw error
    }
  }

  // At boot a failure throws, so boot() rejects and the process exits 1.
  startGeneration()
  const unsubscribe = onWorkerConnectionLost((dead) => {
    if (supervisor.generation.connection !== dead) return
    // Called in the same tick as 'end', so close() marks them closing before they can spin.
    retire(supervisor.generation.workers)
    supervisor.generation.workers = []
    if (supervisor.isClosed || isShuttingDown()) return
    // A failed restart can't throw from inside 'end': readiness stays red
    // instead, until the next pre-ready loss restarts them or the process restarts.
    try {
      startGeneration()
      setWorkersFailed(false)
      logger.info('Workers restarted on a new Redis connection')
    } catch (error) {
      setWorkersFailed(true)
      logger.error('Restarting Workers failed', { error })
    }
  })

  return {
    close: async () => {
      supervisor.isClosed = true
      unsubscribe()
      await Promise.allSettled([
        ...supervisor.generation.workers.map((worker) => worker.close()),
        ...retiring,
      ])
    },
  }
}
