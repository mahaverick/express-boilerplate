/**
 * @file The order of `gracefulShutdown`'s steps, with every dependency
 * mocked to record its call: the Workers close, then the error-report queue
 * is flushed with `ERROR_SHUTDOWN_FLUSH_MS`, then Redis and the other
 * dependencies close, and OTel shuts down last. The real sequence against a
 * live socket is tests/integration/server.test.ts.
 */
import http from 'node:http'
import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import { ERROR_SHUTDOWN_FLUSH_MS } from '@/constants/error-tracking.constants'
import type { SupervisedWorkers } from '@/services/worker-supervisor.service'

const calls = vi.hoisted(() => [] as string[])

/**
 * A mock that records its name, then resolves.
 * @param name - What to record.
 * @returns The mock.
 */
function recorder(name: string): () => Promise<void> {
  return () => {
    calls.push(name)
    return Promise.resolve()
  }
}

vi.mock('@/app', () => ({ createApp: () => express() }))
vi.mock('@/observability/tracing', () => ({ shutdownOtel: () => recorder('shutdownOtel')() }))
vi.mock('@/services/database.service', () => ({ closeDatabase: () => recorder('closeDatabase')() }))
vi.mock('@/services/redis.service', () => ({ closeRedis: () => recorder('closeRedis')() }))
vi.mock('@/services/queue.service', () => ({ closeQueue: () => recorder('closeQueue')() }))
vi.mock('@/services/notification-emitter.service', () => ({
  closeNotificationSubscriber: () => recorder('closeNotificationSubscriber')(),
}))
vi.mock('@/services/errors/error-reporter.service', () => ({
  flushErrorReports: (deadlineMs: number) => recorder(`flushErrorReports(${String(deadlineMs)})`)(),
}))

const { gracefulShutdown } = await import('@/server')

describe('gracefulShutdown', () => {
  it('flushes error reports after the Workers close, before Redis closes and before OTel shuts down', async () => {
    const workers: SupervisedWorkers = { close: recorder('workers.close') }

    await gracefulShutdown(http.createServer(), workers)

    const flush = `flushErrorReports(${String(ERROR_SHUTDOWN_FLUSH_MS)})`
    expect(calls).toContain(flush)
    expect(calls.indexOf('workers.close')).toBeLessThan(calls.indexOf(flush))
    expect(calls.indexOf(flush)).toBeLessThan(calls.indexOf('closeRedis'))
    expect(calls.indexOf(flush)).toBeLessThan(calls.indexOf('closeDatabase'))
    expect(calls.at(-1)).toBe('shutdownOtel')
  })
})
