// tests/unit/services/logger.service.test.ts
//
// Exercises pino logger construction via `createPinoLogger`, never the
// `logger` singleton's own destination — the singleton is memoised off
// `getEnv()`, so a test that wants a specific format builds its own logger
// with a capture `destination`. The singleton tests spy on
// `process.stdout.write`, which is where both the production JSON stream and
// the development pino-pretty stream write.
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestContextStore } from '@/middlewares/request-context.middleware'
import { createPinoLogger, getCallerSource, logger } from '@/services/logger.service'

/**
 * A real Writable that records each chunk as a trimmed string. A real stream
 * (not a `{ write }` literal) because pino-pretty pipes into its destination.
 * @returns The stream to pass as `destination`, and the captured lines.
 */
function captureDestination(): { destination: Writable; output: string[] } {
  const output: string[] = []
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) output.push(line.trim())
      }
      callback()
    },
  })
  return { destination, output }
}

/**
 * Spy on process.stdout.write — where the singleton's stream writes.
 * @returns The captured lines, in write order.
 */
function captureStdout(): string[] {
  const output: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) output.push(line.trim())
    }
    return true
  })
  return output
}

/**
 * Parse the last captured line as a JSON log record.
 * @param output - Lines captured by `captureStdout`.
 * @returns The parsed record, typed as an open bag of fields.
 */
function parseLastRecord(output: string[]): Record<string, unknown> {
  return JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createPinoLogger', () => {
  describe('production format (JSON)', () => {
    it('outputs valid JSON with level, message, timestamp, and source', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        log.info({ source: 'test.ts:1' }, 'test message')

        setImmediate(() => {
          expect(output.length).toBeGreaterThan(0)
          const parsed = parseLastRecord(output)
          expect(parsed.level).toBe('info')
          expect(parsed.message).toBe('test message')
          expect(parsed.source).toBe('test.ts:1')
          expect(parsed.timestamp).toBeDefined()
          resolve()
        })
      }))

    it('serializes Error instances in meta to { name, message, stack }', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'error', isProduction: true, destination })

        const testError = new Error('test failure')
        log.error({ error: testError, source: 'test.ts:1' }, 'something broke')

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          const error = parsed.error as { name: string; message: string; stack: string }
          expect(error.message).toBe('test failure')
          expect(error.name).toBe('Error')
          expect(error.stack).toMatch(/at /)
          resolve()
        })
      }))

    it('includes requestId when called inside an ALS context', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        requestContextStore.run({ requestId: 'abc-123' }, () => {
          log.info({ source: 'test.ts:1' }, 'inside request')
        })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBe('abc-123')
          resolve()
        })
      }))

    it('omits requestId when called outside an ALS context', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        log.info({ source: 'test.ts:1' }, 'no request')

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBeUndefined()
          resolve()
        })
      }))

    it('includes tenantId when the ALS context carries a tenant', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        requestContextStore.run(
          {
            requestId: 'abc-123',
            tenant: { tenantId: 'tenant-1', tenantSlug: 'acme', role: 'admin' },
          },
          () => {
            log.info({ source: 'test.ts:1' }, 'inside tenant-scoped request')
          }
        )

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.tenantId).toBe('tenant-1')
          resolve()
        })
      }))

    it('omits tenantId when the ALS context carries no tenant', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        requestContextStore.run({ requestId: 'abc-123' }, () => {
          log.info({ source: 'test.ts:1' }, 'request with no tenant')
        })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.tenantId).toBeUndefined()
          resolve()
        })
      }))
  })

  describe('development format (human-readable)', () => {
    it('includes time, level, source, and message', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: false, destination })

        log.info({ source: 'server.ts:23' }, 'boot complete')

        setImmediate(() => {
          const line = output.at(-1) ?? ''
          expect(line).toMatch(/info/i)
          expect(line).toContain('[server.ts:23]')
          expect(line).toContain('boot complete')
          resolve()
        })
      }))
  })

  describe('level filtering', () => {
    it('does not output debug when level is info', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: false, destination })

        log.debug({ source: 'test.ts:1' }, 'should not appear')

        setImmediate(() => {
          expect(output).toHaveLength(0)
          resolve()
        })
      }))
  })

  describe('JSON shape parity with the winston era', () => {
    it('emits level as a label, an ISO timestamp, and no pid/hostname', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', isProduction: true, destination })

        log.info({ source: 'test.ts:1' }, 'shape check')

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.level).toBe('info')
          expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          expect(parsed.message).toBe('shape check')
          expect(parsed).not.toHaveProperty('pid')
          expect(parsed).not.toHaveProperty('hostname')
          expect(parsed).not.toHaveProperty('msg')
          expect(parsed).not.toHaveProperty('time')
          resolve()
        })
      }))
  })

  describe('level filtering with Slack configured (multistream)', () => {
    it('still writes debug lines to the console when level is debug', () =>
      new Promise<void>((resolve) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
        const { destination, output } = captureDestination()
        const log = createPinoLogger({
          level: 'debug',
          isProduction: true,
          slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
          slackLogLevel: 'error',
          destination,
        })

        log.debug({ source: 'test.ts:1' }, 'debug survives multistream')

        setImmediate(() => {
          expect(output.some((line) => line.includes('debug survives multistream'))).toBe(true)
          vi.unstubAllGlobals()
          resolve()
        })
      }))
  })
})

describe('logger singleton', () => {
  // Exercises the real `logger.info/warn/error/debug` bodies — `getLogger()`,
  // the `isLevelEnabled()` guard, and `getCallerSource()`'s two-frame skip
  // (its own frame, then the `Object.info`/`Object.warn`/... wrapper frame
  // inside logger.service.ts) — through the actual singleton rather than a
  // mock standing in for it. The mock-and-assert-it-was-called version this
  // replaced never ran any of that code.
  it('info writes a formatted line naming this test file as the source', () =>
    new Promise<void>((resolve) => {
      const output = captureStdout()

      logger.info('via singleton')

      setImmediate(() => {
        const line = output.at(-1) ?? ''
        expect(line).toContain('via singleton')
        expect(line).toMatch(/logger\.service\.test\.ts:\d+/)
        resolve()
      })
    }))

  it('warn and error also reach the transport', () =>
    new Promise<void>((resolve) => {
      const output = captureStdout()

      logger.warn('careful')
      logger.error('broke', { error: new Error('boom') })

      setImmediate(() => {
        expect(output.some((line) => line.includes('careful'))).toBe(true)
        expect(output.some((line) => line.includes('broke'))).toBe(true)
        resolve()
      })
    }))

  it('debug is suppressed at the default test LOG_LEVEL (info)', () =>
    new Promise<void>((resolve) => {
      const output = captureStdout()

      logger.debug('suppressed')

      setImmediate(() => {
        expect(output).toHaveLength(0)
        resolve()
      })
    }))
})

describe('trace-id correlation', () => {
  // OTEL is not active in this test run — .env.test (tests/helpers/setup-global.ts)
  // never sets OTEL_EXPORTER_OTLP_ENDPOINT, so src/observability/tracing.ts's
  // SDK is never started and no global tracer provider is registered.
  // trace.getActiveSpan() (requestContextFields, logger.service.ts) is then
  // guaranteed to return undefined regardless of call site — there is no
  // "active span" to be outside of. Exercising that with OTEL genuinely
  // active would mean starting a real NodeSDK, which is the integration
  // concern tracing.test.ts's own header comment defers.
  it('omits traceId/spanId from log output when no span is active', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', isProduction: true, destination })

      log.info({ source: 'test.ts:1' }, 'no active span')

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.traceId).toBeUndefined()
        expect(parsed.spanId).toBeUndefined()
        resolve()
      })
    }))
})

describe('caller location extraction', () => {
  it('source field names the calling file, not logger.service.ts', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', isProduction: true, destination })

      log.info({ source: getCallerSource() }, 'from test')

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.source).toMatch(/logger\.service\.test\.ts:\d+/)
        expect(parsed.source).not.toContain('logger.service.ts:')
        resolve()
      })
    }))
})
