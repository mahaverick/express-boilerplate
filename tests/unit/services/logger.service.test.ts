// tests/unit/services/logger.service.test.ts
//
// Exercises Winston logger construction via `createWinstonLogger`, never the
// `logger` singleton's own transport — the singleton's underlying logger is
// memoised off `getEnv()` (see that module's own comment), so a test that
// wants a specific format (production JSON vs. development text) builds its
// own logger instance instead of trying to fight the cache.
//
// Capturing output means spying on `console._stdout.write`, not attaching a
// throwaway stream via `log.add()`: `transports.Console` — what
// `createWinstonLogger` actually constructs — writes through
// `console._stdout` by default, and a transport added via `log.add()` gets
// no format of its own unless one is explicitly given, so it would receive
// the raw `info` object with no rendered `MESSAGE` to read back.
//
// `console._stdout` rather than `process.stdout`: Vitest's own console
// wrapper (the thing behind `console.log` inside a test) replaces
// `console._stdout` with a per-test capture stream that is NOT
// `process.stdout` — verified empirically, spying on `process.stdout.write`
// captures nothing here. Winston's Console transport always writes through
// whichever object `console._stdout` currently is, so spying on that,
// through the same identifier Winston itself reads, is what actually
// observes its output regardless of which stream backs it. `_stdout` is an
// undocumented Node internal, which is exactly why this is isolated in one
// small helper rather than spread across every test.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestContextStore } from '@/middlewares/request-context.middleware'
import { createWinstonLogger, getCallerSource, logger } from '@/services/logger.service'

interface ConsoleWithInternalStreams {
  _stdout: NodeJS.WritableStream
}

/**
 * Spy on the stream Winston's Console transport actually writes to inside
 * this test run, silencing it and recording every chunk written as a
 * trimmed string.
 * @returns The captured lines, in write order.
 */
function captureStdout(): string[] {
  const output: string[] = []
  const stdout = (console as unknown as ConsoleWithInternalStreams)._stdout
  vi.spyOn(stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(chunk.toString().trim())
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

describe('createWinstonLogger', () => {
  describe('production format (JSON)', () => {
    it('outputs valid JSON with level, message, timestamp, and source', () =>
      new Promise<void>((resolve) => {
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'info', isProduction: true })

        log.info('test message', { source: 'test.ts:1' })

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
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'error', isProduction: true })

        const testError = new Error('test failure')
        log.error('something broke', { error: testError, source: 'test.ts:1' })

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
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'info', isProduction: true })

        requestContextStore.run({ requestId: 'abc-123' }, () => {
          log.info('inside request', { source: 'test.ts:1' })
        })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBe('abc-123')
          resolve()
        })
      }))

    it('omits requestId when called outside an ALS context', () =>
      new Promise<void>((resolve) => {
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'info', isProduction: true })

        log.info('no request', { source: 'test.ts:1' })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBeUndefined()
          resolve()
        })
      }))
  })

  describe('development format (human-readable)', () => {
    it('includes time, level, source, and message', () =>
      new Promise<void>((resolve) => {
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'info', isProduction: false })

        log.info('boot complete', { source: 'server.ts:23' })

        setImmediate(() => {
          const line = output.at(-1) ?? ''
          expect(line).toContain('info')
          expect(line).toContain('[server.ts:23]')
          expect(line).toContain('boot complete')
          resolve()
        })
      }))
  })

  describe('level filtering', () => {
    it('does not output debug when level is info', () =>
      new Promise<void>((resolve) => {
        const output = captureStdout()
        const log = createWinstonLogger({ level: 'info', isProduction: false })

        log.debug('should not appear', { source: 'test.ts:1' })

        setImmediate(() => {
          expect(output).toHaveLength(0)
          resolve()
        })
      }))
  })
})

describe('logger singleton', () => {
  // Exercises the real `logger.info/warn/error/debug` bodies — `getLogger()`,
  // the `isXEnabled()` guard, and `getCallerSource()`'s two-frame skip
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
  // trace.getActiveSpan() (addRequestContext, logger.service.ts) is then
  // guaranteed to return undefined regardless of call site — there is no
  // "active span" to be outside of. Exercising that with OTEL genuinely
  // active would mean starting a real NodeSDK, which is the integration
  // concern tracing.test.ts's own header comment defers.
  it('omits traceId/spanId from log output when no span is active', () =>
    new Promise<void>((resolve) => {
      const output = captureStdout()
      const log = createWinstonLogger({ level: 'info', isProduction: true })

      log.info('no active span', { source: 'test.ts:1' })

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
      const output = captureStdout()
      const log = createWinstonLogger({ level: 'info', isProduction: true })

      log.info('from test', { source: getCallerSource() })

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.source).toMatch(/logger\.service\.test\.ts:\d+/)
        expect(parsed.source).not.toContain('logger.service.ts:')
        resolve()
      })
    }))
})
