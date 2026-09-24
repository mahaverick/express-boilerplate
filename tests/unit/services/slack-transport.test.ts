// tests/unit/services/slack-transport.test.ts
//
// Exercises the Slack destination indirectly through `createPinoLogger`
// (it is internal to logger.service.ts, not exported) by stubbing global
// `fetch` and asserting on what it was called with. The destination is
// wired in via `pino.multistream`, alongside the console stream — every
// `createPinoLogger` call below passes a discard `destination` so console
// output doesn't pollute the run; the Slack destination is what the
// assertions actually target.
//
// Same `new Promise<void>((resolve) => { ...; setImmediate(() => { ...;
// resolve() }) })` pattern as logger.service.test.ts, not a Jest-style
// `(done) => {...}` callback param — Vitest 5 has no special handling for a
// callback-arity test function, so a `done` parameter is simply never
// invoked as a completion signal and the test would "pass" without ever
// running its assertions. `setImmediate` is still needed: a raw `{ write }`
// destination (the Slack destination, the discard stream below) is called
// synchronously by pino.multistream — verified directly against the
// installed pino, not assumed — so the fetch() call itself happens before
// log.error() returns; but sendToSlack awaits fetch's response before
// checking `response.ok` or catching a rejection, and several assertions
// here (the non-OK/thrown-error console.error cases, the dedup summary
// after `response.ok` is read) depend on that await having settled.
// `setImmediate` runs in the event loop's "check" phase, after those
// pending promise microtasks have already flushed.
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestContextStore } from '@/middlewares/request-context.middleware'
import { createPinoLogger } from '@/services/logger.service'

// Narrower than the global RequestInit on purpose: the Slack destination
// always calls fetch with a string `body` (JSON.stringify'd), never the
// other BodyInit variants (Blob, ArrayBuffer, ...) that real RequestInit
// allows — typing `body` loosely as `unknown` would make every
// `options.body` read below trip @typescript-eslint/no-base-to-string.
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

describe('Slack transport', () => {
  const mockFetch = vi.fn<FetchProcedure>()

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // Defensive: only the dedup-summary test below enables fake timers, but
    // restore unconditionally so a thrown assertion in that test can never
    // leak fake timers into a later, unrelated test file.
    vi.useRealTimers()
  })

  it('sends a POST to the webhook URL for an error-level log', () =>
    new Promise<void>((resolve) => {
      const log = createPinoLogger({
        level: 'error',
        isProduction: true,
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
        isProduction: true,
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
        isProduction: true,
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
      // Only setTimeout/clearTimeout are faked, deliberately — the Slack
      // destination's own dedup timer is the thing under test, but
      // setImmediate (used below to flush pino's stream pipeline) must keep
      // running for real, or nothing in this test would ever observe a result.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const log = createPinoLogger({
        level: 'error',
        isProduction: true,
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
      // Same shape as the singular test above, but THREE calls (two
      // suppressed, not one) — the summary's own grammar ternary
      // (buildSlackSummaryPayload, logger.service.ts) is `count === 1 ? '' :
      // 's'`, and the singular test above only ever proves the `''` arm.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const log = createPinoLogger({
        level: 'error',
        isProduction: true,
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
        isProduction: true,
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
        isProduction: true,
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
        isProduction: true,
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
        isProduction: true,
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
        isProduction: true,
        destination: discardDestination(),
      })

      log.error({ source: 'test.ts:1' }, 'no slack')

      setImmediate(() => {
        expect(mockFetch).not.toHaveBeenCalled()
        resolve()
      })
    }))
})
