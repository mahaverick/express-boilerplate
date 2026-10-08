/**
 * @file Exercises the Slack destination indirectly through
 * `createPinoLogger` (it is internal to logger.service.ts, not
 * exported) by stubbing global `fetch` and asserting on what it was
 * called with.
 */
import { Writable } from 'node:stream'
import { DrizzleQueryError } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinoLogger } from '@/services/logger.service'
import { requestContextStore } from '@/services/request-context.service'
import { LEAKED_PARAM } from '../../helpers/query-error'

const scrub = vi.hoisted(() => ({ shouldThrow: false }))

vi.mock('@/services/errors/error-scrubber.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/errors/error-scrubber.service')>()
  return {
    ...actual,
    scrubText: (value: string): string => {
      if (scrub.shouldThrow) throw new Error('scrub broke')
      return actual.scrubText(value)
    },
  }
})

/**
 * Narrower than the global RequestInit on purpose: the Slack destination
 * always calls fetch with a string `body` (JSON.stringify'd), never the
 * other BodyInit variants (Blob, ArrayBuffer, ...) that real RequestInit
 * allows — typing `body` loosely as `unknown` would make every
 * `options.body` read below trip the no-base-to-string lint rule.
 */
interface SlackFetchInit {
  method: string
  headers: Record<string, string>
  body: string
}

type FetchProcedure = (
  url: string,
  init: SlackFetchInit
) => Promise<{ ok: boolean; status?: number }>

/**
 * A discard destination for the console stream, so tests that only care
 * about the Slack destination don't also print to the real stdout.
 * @returns A Writable that swallows every chunk.
 */
function discardDestination(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback): void {
      callback()
    },
  })
}

/**
 * The Slack destination is wired in via `pino.multistream`, alongside
 * the console stream — every `createPinoLogger` call below passes a
 * discard `destination` so console output doesn't pollute the run; the
 * Slack destination is what the assertions actually target. Each test
 * wraps its body in `new Promise<void>((resolve) => { ...;
 * setImmediate(() => { ...; resolve() }) })` rather than a Jest-style
 * `(done) => {...}` callback param, since Vitest 5 has no special
 * handling for a callback-arity test function and a `done` parameter is
 * simply never invoked. `setImmediate` is needed because a raw `{
 * write }` destination (the Slack destination, the discard stream
 * below) is called synchronously by pino.multistream, so the fetch()
 * call itself happens before log.error() returns, but sendToSlack
 * awaits fetch's response before checking `response.ok` or catching a
 * rejection — several assertions here depend on that await having
 * settled, and `setImmediate` runs in the event loop's "check" phase,
 * after those pending promise microtasks have already flushed.
 */
describe('Slack transport', () => {
  const mockFetch = vi.fn<FetchProcedure>()

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // Defensive: only the dedup-summary test below enables fake timers, but restore unconditionally so a thrown assertion in that test can never leak fake timers into a later, unrelated test file.
    vi.useRealTimers()
  })

  it('sends a POST to the webhook URL for an error-level log', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'database.service.ts:50' }, 'db connection failed')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        const [url, options] = mockFetch.mock.calls[0] as [string, SlackFetchInit]
        expect(url).toBe('https://hooks.slack.com/services/T/B/X')
        expect(options.method).toBe('POST')
        const body = JSON.parse(options.body) as {
          attachments: { blocks: { text: { text: string } }[] }[]
        }
        expect(body.attachments[0]?.blocks[0]?.text.text).toContain('db connection failed')
        resolve()
      })
    }))

  it('does not send to Slack when level is below SLACK_LOG_LEVEL', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'info',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.info({ source: 'test.ts:1' }, 'just info')

      setImmediate(() => {
        expect(mockFetch).not.toHaveBeenCalled()
        resolve()
      })
    }))

  it('deduplicates: first occurrence sends, second within window is suppressed', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'same error')
      log.error({ source: 'test.ts:1' }, 'same error')
      log.error({ source: 'test.ts:1' }, 'same error')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        resolve()
      })
    }))

  it('sends a single summary message once the dedup window closes, only when there were repeats', () =>
    new Promise<void>((resolve) => {
      // Only setTimeout/clearTimeout are faked, deliberately — the Slack destination's own dedup timer is the thing under test, but setImmediate (used below to flush pino's stream pipeline) must keep running for real, or nothing in this test would ever observe a result.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'flaky dependency')
      log.error({ source: 'test.ts:1' }, 'flaky dependency')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()

        vi.advanceTimersByTime(60_000)

        setImmediate(() => {
          expect(mockFetch).toHaveBeenCalledTimes(2)
          const [, options] = mockFetch.mock.calls[1] as [string, SlackFetchInit]
          const body = JSON.parse(options.body) as { text: string }
          expect(body.text).toContain('Suppressed 1 duplicate occurrence of "flaky dependency"')
          resolve()
        })
      })
    }))

  it('pluralizes the summary message when more than one occurrence was suppressed', () =>
    new Promise<void>((resolve) => {
      // Same shape as the singular test above, but three calls (two suppressed, not one) — the summary's own grammar ternary (buildSlackSummaryPayload, logger.service.ts) is `count === 1 ? '' : 's'`, and the singular test above only ever proves the `''` arm.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'flaky dependency')
      log.error({ source: 'test.ts:1' }, 'flaky dependency')
      log.error({ source: 'test.ts:1' }, 'flaky dependency')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()

        vi.advanceTimersByTime(60_000)

        setImmediate(() => {
          expect(mockFetch).toHaveBeenCalledTimes(2)
          const [, options] = mockFetch.mock.calls[1] as [string, SlackFetchInit]
          const body = JSON.parse(options.body) as { text: string }
          expect(body.text).toContain('Suppressed 2 duplicate occurrences of "flaky dependency"')
          resolve()
        })
      })
    }))

  it('includes the error stack trace when an Error is present in meta', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ error: new Error('root cause'), source: 'test.ts:1' }, 'boom')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        const [, options] = mockFetch.mock.calls[0] as [string, SlackFetchInit]
        const body = JSON.parse(options.body) as {
          attachments: { blocks: { text?: { text: string } }[] }[]
        }
        const stackBlock = body.attachments[0]?.blocks[2]
        expect(stackBlock?.text?.text).toContain('root cause')
        resolve()
      })
    }))

  it('does not throw when the webhook fetch fails', () =>
    new Promise<void>((resolve) => {
      mockFetch.mockRejectedValueOnce(new Error('network error'))
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'should not throw')

      setImmediate(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Slack webhook failed', expect.any(Error))
        consoleErrorSpy.mockRestore()
        resolve()
      })
    }))

  it('logs to console when the webhook responds with a non-OK status', () =>
    new Promise<void>((resolve) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'webhook revoked')

      setImmediate(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Slack webhook failed', 404)
        consoleErrorSpy.mockRestore()
        resolve()
      })
    }))

  it('includes the ALS requestId in a *Request:* field of the Slack payload', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination: discardDestination(),
      })

      requestContextStore.run({ requestId: 'test-123' }, () => {
        log.error({ source: 'test.ts:1' }, 'correlated failure')
      })

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        const [, options] = mockFetch.mock.calls[0] as [string, SlackFetchInit]
        expect(options.body).toContain('*Request:*')
        expect(options.body).toContain('test-123')
        resolve()
      })
    }))

  it('is not registered when slackWebhookUrl is unset', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        format: 'json',
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'no slack')

      setImmediate(() => {
        expect(mockFetch).not.toHaveBeenCalled()
        resolve()
      })
    }))
})

/**
 * A logger whose error-level records go to the stubbed Slack webhook.
 * @returns The logger.
 */
function slackLogger(): ReturnType<typeof createPinoLogger> {
  return createPinoLogger({
    level: 'info',
    format: 'json',
    slackWebhookUrl: 'https://hooks.slack.invalid/services/T/B/x',
    slackLogLevel: 'error',
    destination: discardDestination(),
  })
}

describe('Slack transport scrubbing', () => {
  const mockFetch = vi.fn<FetchProcedure>()
  // Built at runtime so secret scanners do not flag a fake key in source.
  const resendKey = ['re', 'zqS09Abc123', 'DEFghi456JKL'].join('_')
  const bearer = 'zqS09bearerTokenValue77'

  /**
   * Every webhook body sent so far, joined.
   * @returns The bodies.
   */
  function sentBodies(): string {
    return mockFetch.mock.calls.map(([, init]) => init.body).join('\n')
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not send a credential in an error message to Slack', () =>
    new Promise<void>((resolve) => {
      slackLogger().error(
        {
          error: new Error(
            `SMTP auth failed for key ${resendKey}; Authorization: Bearer ${bearer}`
          ),
        },
        `Email worker error (Authorization: Bearer ${bearer})`
      )

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        expect(sentBodies()).not.toContain(resendKey)
        expect(sentBodies()).not.toContain(bearer)
        resolve()
      })
    }))

  it('scrubs the source field', () =>
    new Promise<void>((resolve) => {
      slackLogger().error({ source: 'auth.ts:1 token=zqS09srcTok' }, 'failed')

      setImmediate(() => {
        expect(sentBodies()).toContain('auth.ts:1 token=[redacted]')
        expect(sentBodies()).not.toContain('zqS09srcTok')
        resolve()
      })
    }))

  it('sends a query error redacted, without its bound values', () =>
    new Promise<void>((resolve) => {
      const error = new DrizzleQueryError(
        'select * from users where email = $1',
        ['jane.zqS09@example.com'],
        new Error('connection reset')
      )
      slackLogger().error({ error }, 'query failed')

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        expect(sentBodies()).not.toContain('jane.zqS09@example.com')
        resolve()
      })
    }))

  it('keeps stack frame paths readable', () =>
    new Promise<void>((resolve) => {
      const error = new Error('boom')
      Object.defineProperty(error, 'stack', {
        value: 'Error: boom\n    at handle (/app/src/services/auth.service.ts:10:5)',
      })
      slackLogger().error({ error }, 'handler failed')

      setImmediate(() => {
        expect(sentBodies()).toContain('at handle (/app/src/services/auth.service.ts:10:5)')
        resolve()
      })
    }))

  it('scrubs the duplicate summary too', () =>
    new Promise<void>((resolve) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const log = slackLogger()
      log.error({ source: 'test.ts:1' }, `retry failed, Bearer ${bearer}`)
      log.error({ source: 'test.ts:1' }, `retry failed, Bearer ${bearer}`)

      setImmediate(() => {
        vi.advanceTimersByTime(60_000)

        setImmediate(() => {
          expect(mockFetch).toHaveBeenCalledTimes(2)
          expect(sentBodies()).toContain('Suppressed 1 duplicate occurrence')
          expect(sentBodies()).not.toContain(bearer)
          resolve()
        })
      })
    }))
})

describe('Slack transport scrub failure', () => {
  const mockFetch = vi.fn<FetchProcedure>()

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)
    scrub.shouldThrow = true
  })

  afterEach(() => {
    scrub.shouldThrow = false
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends fixed text, never the raw record, and does not throw into the caller', () =>
    new Promise<void>((resolve) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() => {
        slackLogger().error({ error: new Error('x') }, `raw ${LEAKED_PARAM}`)
      }).not.toThrow()

      setImmediate(() => {
        expect(mockFetch).toHaveBeenCalledOnce()
        const body = String(mockFetch.mock.calls[0]?.[1].body)
        expect(body).toContain('could not be scrubbed')
        expect(body).not.toContain(LEAKED_PARAM)
        expect(consoleError).toHaveBeenCalledWith('Slack payload scrub failed', 'Error')
        resolve()
      })
    }))
})
