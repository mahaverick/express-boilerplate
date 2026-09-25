// tests/unit/services/logger.service.test.ts
//
// Exercises pino logger construction via `createPinoLogger`, never the
// `logger` singleton's own destination — the singleton is memoised off
// `getEnv()`, so a test that wants a specific format builds its own logger
// with a capture `destination`. The singleton tests spy on
// `process.stdout.write`, which is where both the JSON stream and the
// pino-pretty stream write.
import { Writable } from 'node:stream'
import { context, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createPinoLogger,
  getCallerSource,
  logger,
  loggerOptionsFromEnv,
  pinoPrettyLoader,
} from '@/services/logger.service'
import { requestContextStore } from '@/services/request-context.service'
import { withMutatedMethod } from '../../helpers/mutate'

// .env.test sets LOG_LEVEL=silent to keep the suite's output readable, but the
// `logger singleton` block below asserts on what the REAL singleton writes at
// `info`. Hoisted so it runs before anything calls getEnv(), which memoises
// the level for the rest of this file.
vi.hoisted(() => {
  process.env.LOG_LEVEL = 'info'
})

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
  describe('json format', () => {
    it('outputs valid JSON with level, message, timestamp, and source', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

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
        const log = createPinoLogger({ level: 'error', format: 'json', destination })

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
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

        requestContextStore.run({ requestId: 'abc-123' }, () => {
          log.info({ source: 'test.ts:1' }, 'inside request')
        })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBe('abc-123')
          resolve()
        })
      }))

    // Winston-era behaviour: request-context correlation fields must win
    // over a caller-supplied field of the same name, not merge in whatever
    // order pino happens to combine the mixin and the log call's own
    // object. Without mixinMergeStrategy, pino's default merge lets the
    // logged object's own `requestId` overwrite the mixin's.
    it('the real request context requestId wins over a caller-supplied requestId in meta', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

        requestContextStore.run({ requestId: 'real-id' }, () => {
          log.info({ requestId: 'spoofed', source: 'test.ts:1' }, 'x')
        })

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          expect(parsed.requestId).toBe('real-id')
          resolve()
        })
      }))

    it('omits requestId when called outside an ALS context', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

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
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

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
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

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

  describe('the err key', () => {
    // pino's own default `err` serializer re-processes whatever is already
    // under `err` into `{ type, message, stack }` — so serializeErrors's
    // { name, message, stack } (from an Error instance) gets run through it
    // a second time, landing as `{ type: 'Object', message, stack, name }`.
    // The `err` key must instead pass through serializeErrors's output
    // untouched.
    it('does not re-serialize err through pino default serializer, and carries no type key', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'error', format: 'json', destination })

        log.error({ err: new Error('boom'), source: 'test.ts:1' }, 'x')

        setImmediate(() => {
          const parsed = parseLastRecord(output)
          const parsedError = parsed.err as { name: string; message: string; stack: string }
          expect(Object.keys(parsedError)).toHaveLength(3)
          expect(parsedError.name).toBe('Error')
          expect(parsedError.message).toBe('boom')
          expect(parsedError.stack).toMatch(/at /)
          expect(parsedError).not.toHaveProperty('type')
          resolve()
        })
      }))
  })

  describe('pretty format (human-readable)', () => {
    it('includes time, level, source, and message', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', format: 'pretty', destination })

        log.info({ source: 'server.ts:23' }, 'boot complete')

        setImmediate(() => {
          const line = output.at(-1) ?? ''
          expect(line).toMatch(/info/i)
          expect(line).toMatch(/\d{2}:\d{2}:\d{2}/)
          expect(line).toContain('[server.ts:23]')
          expect(line).toContain('boot complete')
          resolve()
        })
      }))
  })

  describe('pino-pretty unavailable (pruned image, pretty format)', () => {
    it('falls back to raw JSON output instead of throwing', async () => {
      const { destination, output } = captureDestination()

      await withMutatedMethod(
        pinoPrettyLoader,
        'load',
        () => {
          throw Object.assign(new Error("Cannot find module 'pino-pretty'"), {
            code: 'MODULE_NOT_FOUND',
          })
        },
        () =>
          new Promise<void>((resolve) => {
            const log = createPinoLogger({ level: 'info', format: 'pretty', destination })

            log.info({ source: 'test.ts:1' }, 'pruned image fallback')

            setImmediate(() => {
              const parsed = parseLastRecord(output)
              expect(parsed.message).toBe('pruned image fallback')
              expect(parsed.level).toBe('info')
              resolve()
            })
          })
      )
    })

    it('rethrows an error that is not MODULE_NOT_FOUND', async () => {
      await expect(
        withMutatedMethod(
          pinoPrettyLoader,
          'load',
          () => {
            throw new Error('some other failure')
          },
          () => {
            createPinoLogger({ level: 'info', format: 'pretty', destination: process.stdout })
          }
        )
      ).rejects.toThrow('some other failure')
    })
  })

  describe('level filtering', () => {
    it('does not output debug when level is info', () =>
      new Promise<void>((resolve) => {
        const { destination, output } = captureDestination()
        const log = createPinoLogger({ level: 'info', format: 'pretty', destination })

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
        const log = createPinoLogger({ level: 'info', format: 'json', destination })

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
          format: 'json',
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

describe('loggerOptionsFromEnv', () => {
  const base: Parameters<typeof loggerOptionsFromEnv>[0] = {
    LOG_LEVEL: 'info',
    APP_ENV: 'local',
    SLACK_LOG_LEVEL: 'error',
  }

  it('writes pretty text on local and JSON on every other APP_ENV when LOG_FORMAT is unset', () => {
    expect(loggerOptionsFromEnv(base).format).toBe('pretty')
    for (const appEnv of ['dev', 'qa', 'prod'] as const) {
      expect(loggerOptionsFromEnv({ ...base, APP_ENV: appEnv }).format).toBe('json')
    }
  })

  it('lets LOG_FORMAT override the APP_ENV default in both directions', () => {
    expect(loggerOptionsFromEnv({ ...base, APP_ENV: 'prod', LOG_FORMAT: 'pretty' }).format).toBe(
      'pretty'
    )
    expect(loggerOptionsFromEnv({ ...base, LOG_FORMAT: 'json' }).format).toBe('json')
  })

  it('passes the level and Slack settings through, and omits an unset webhook', () => {
    expect(loggerOptionsFromEnv({ ...base, LOG_LEVEL: 'debug' })).toEqual({
      level: 'debug',
      format: 'pretty',
      slackLogLevel: 'error',
    })
    expect(
      loggerOptionsFromEnv({ ...base, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' })
        .slackWebhookUrl
    ).toBe('https://hooks.slack.com/services/T/B/X')
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

  it('debug is suppressed at LOG_LEVEL=info', () =>
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
  // own NodeSDK is never started for this suite. But `trace.getActiveSpan()`
  // (requestContextFields, logger.service.ts) reads OTel's GLOBAL context
  // manager, not anything tracing.ts owns — so this describe block registers
  // its own, real `AsyncLocalStorageContextManager` (the same context-manager
  // package tracing.ts's NodeSDK would use) to exercise both branches of the
  // mixin without starting a full SDK: `context.with(trace.setSpan(...))`
  // makes a span active for the span-present test below, and simply not
  // entering that context (as here) leaves none active, so
  // `trace.getActiveSpan()` returns undefined for a reason specific to this
  // call site, not because no context manager exists at all.
  beforeAll(() => {
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
      true
    )
  })

  afterAll(() => {
    context.disable()
  })

  it('omits traceId/spanId from log output when no span is active', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', format: 'json', destination })

      log.info({ source: 'test.ts:1' }, 'no active span')

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.traceId).toBeUndefined()
        expect(parsed.spanId).toBeUndefined()
        resolve()
      })
    }))

  it('includes traceId/spanId matching the active span when one is active', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', format: 'json', destination })

      // trace.wrapSpanContext gives a real, minimal Span backed by exactly
      // the ids chosen here, so the assertion below is exact-string equality
      // against a known value — not merely "matches the shape of an id".
      const spanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      }
      const span = trace.wrapSpanContext(spanContext)

      context.with(trace.setSpan(context.active(), span), () => {
        log.info({ source: 'test.ts:1' }, 'inside active span')
      })

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.traceId).toBe(spanContext.traceId)
        expect(parsed.spanId).toBe(spanContext.spanId)
        resolve()
      })
    }))
})

describe('caller location extraction', () => {
  it('source field names the calling file, not logger.service.ts', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', format: 'json', destination })

      log.info({ source: getCallerSource() }, 'from test')

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.source).toMatch(/logger\.service\.test\.ts:\d+/)
        expect(parsed.source).not.toContain('logger.service.ts:')
        resolve()
      })
    }))
})
