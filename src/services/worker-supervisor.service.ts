// src/services/worker-supervisor.service.ts
//
// Starts the email and notification Workers and keeps them on a live
// connection. A Worker whose connection gave up before its first 'ready'
// never recovers: BullMQ's own init has rejected for good, and unless that
// error is ECONNREFUSED (ECONNRESET, say) its fetch loop retries with no
// delay and starves the event loop. So when that connection ends, the
// supervisor closes those Workers at once and starts new ones on a fresh
// connection. While Redis stays down this repeats on each connection's
// pre-ready give-up (about 1.2s), never faster.
import type { Worker } from 'bullmq'
import type IORedis from 'ioredis'
import { isShuttingDown } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { getQueueConnection, onWorkerConnectionLost } from '@/services/queue.service'
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
  connection: IORedis
  workers: Worker[]
}

/**
 * Start both Workers on the shared Worker connection.
 * @returns The Workers and the connection they run on.
 */
function startGeneration(): WorkerGeneration {
  const connection = getQueueConnection()
  return { connection, workers: [startEmailWorker(), startNotificationWorker()] }
}

/**
 * Close Workers without waiting for their jobs, logging any failure.
 * @param workers - Workers whose connection has ended.
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
 */
export function startWorkers(): SupervisedWorkers {
  const supervisor = { generation: startGeneration(), isClosed: false }
  const retiring = new Set<Promise<void>>()

  const unsubscribe = onWorkerConnectionLost((dead) => {
    if (supervisor.generation.connection !== dead) return
    // Called in the same tick as 'end', so close() marks them closing before they can spin.
    const closing = closeLostWorkers(supervisor.generation.workers)
    retiring.add(closing)
    void closing.finally(() => retiring.delete(closing))
    if (supervisor.isClosed || isShuttingDown()) return
    try {
      supervisor.generation = startGeneration()
      logger.info('Workers restarted on a new Redis connection')
    } catch (error) {
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
