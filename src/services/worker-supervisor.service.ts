/**
 * @file Starts the email, notification and maintenance Workers and keeps them on
 * a live connection, replacing them whenever their connection gives up before its
 * first 'ready' (see `startWorkers`).
 */
import type { Worker } from 'bullmq'
import type IORedis from 'ioredis'
import { ensureRetentionSchedule } from '@/jobs/maintenance.job'
import { isShuttingDown } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import {
  getQueueConnection,
  onWorkerConnectionLost,
  setWorkersFailed,
} from '@/services/queue.service'
import { startEmailWorker } from '@/workers/email.worker'
import { startMaintenanceWorker } from '@/workers/maintenance.worker'
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
 * Start the email, notification and maintenance Workers, replacing them whenever their connection gives up before its first ready.
 *
 * A Worker on such a connection never recovers: BullMQ's init has rejected for
 * good, and unless the error is one BullMQ counts as a connection error
 * (ECONNREFUSED, or "Connection is closed.") its fetch loop retries with no
 * delay and starves the event loop. So those Workers are closed inside the
 * connection's 'end' event and new ones start on a fresh connection. While
 * Redis stays down this repeats on each pre-ready give-up, at least ~1.2s
 * apart (longer when connects time out).
 *
 * A failed first start throws. A failed restart cannot throw from inside
 * 'end', so it calls `setWorkersFailed(true)` and readiness stays red until a
 * later restart succeeds or the process restarts.
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

  const startGeneration = (): void => {
    const generation: WorkerGeneration = { connection: undefined, workers: [] }
    supervisor.generation = generation
    try {
      generation.connection = getQueueConnection()
      // One at a time, so a throw leaves the ones already started in `workers`.
      for (const start of [startEmailWorker, startNotificationWorker, startMaintenanceWorker]) {
        generation.workers.push(start())
      }
      // Each generation retries, so a Redis outage at boot can't leave the purge unscheduled.
      void ensureRetentionSchedule().catch((error: unknown) => {
        logger.warn('Registering the retention schedule failed', { error })
      })
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
