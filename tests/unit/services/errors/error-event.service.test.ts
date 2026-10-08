/**
 * @file The event builder: the exception list (cause depth, frame cap,
 * in_app, scrubbing), what it never reads (a Postgres error's detail,
 * parameters, query and where; a failed query's parameters; an HttpError's
 * errors), the fingerprint, the properties and identity of a signed event,
 * and the span stand-in. No database, Redis or PostHog.
 */
import { inspect } from 'node:util'
import { trace } from '@opentelemetry/api'
import postgres from 'postgres'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_SIGNATURE_PROPERTY } from '@/constants/analytics.constants'
import { ERROR_CAUSE_DEPTH } from '@/constants/error-tracking.constants'
import { HttpError } from '@/errors/http-error'
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import {
  buildErrorEvent,
  exceptionListOf,
  fingerprintOf,
  scrubbedErrorForSpan,
  type ErrorContext,
} from '@/services/errors/error-event.service'
import { requestContextStore } from '@/services/request-context.service'
import { withMutatedModule } from '../../../helpers/mutate'
import { fakeQueryError, LEAKED_PARAM } from '../../../helpers/query-error'

const ERROR_ID = '0199a1b2-0000-7000-8000-0000000000e1'
const AT = new Date('2026-10-04T12:00:00.000Z')
const HTTP: ErrorContext = {
  capturePoint: 'http',
  handled: true,
  http: { method: 'GET', route: '/api/v1/things/:id', status: 500, requestId: 'req-1' },
}

/**
 * An error whose stack is exactly the given frame lines.
 * @param message - The message.
 * @param frames - Frame lines, innermost first, as V8 writes them.
 * @returns The error.
 */
function errorWithFrames(message: string, frames: string[]): Error {
  const error = new Error(message)
  Object.defineProperty(error, 'stack', { value: [`Error: ${message}`, ...frames].join('\n') })
  return error
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exceptionListOf', () => {
  it('follows the cause chain to at most five exceptions', () => {
    const chain = Array.from({ length: 7 }, (_, index) => new Error(`link ${String(index)}`))
    for (const [index, error] of chain.entries()) {
      if (index > 0) chain[index - 1]!.cause = error
    }
    const list = exceptionListOf(chain[0])
    expect(list.map((exception) => exception.value)).toEqual([
      'link 0',
      'link 1',
      'link 2',
      'link 3',
      'link 4',
    ])
  })

  it('stops on a cyclic cause chain', () => {
    const a = new Error('a')
    const c = new Error('c', { cause: a })
    Object.defineProperty(a, 'cause', { value: c })
    const list = exceptionListOf(a)
    expect(list.length).toBeGreaterThan(0)
    expect(list.length).toBeLessThanOrEqual(ERROR_CAUSE_DEPTH)
  })

  it('keeps the innermost 50 of 60 frames, outermost first', () => {
    const frames = Array.from(
      { length: 60 },
      (_, index) => `    at fn${String(index)} (/app/src/f${String(index)}.ts:1:1)`
    )
    const [first] = exceptionListOf(errorWithFrames('deep', frames))
    const kept = first?.stacktrace?.frames ?? []
    expect(kept).toHaveLength(50)
    expect(kept.at(-1)?.function).toBe('fn0')
    expect(kept[0]?.function).toBe('fn49')
  })

  it('names every frame’s platform node:javascript, the value PostHog groups', () => {
    const [first] = exceptionListOf(
      errorWithFrames('p', ['    at handler (/app/src/controllers/thing.controller.ts:10:5)'])
    )
    expect(first?.stacktrace?.frames?.map((frame) => frame.platform)).toEqual(['node:javascript'])
  })

  it('marks node: and node_modules frames as not in_app', () => {
    const [first] = exceptionListOf(
      errorWithFrames('mixed', [
        '    at handler (/app/src/controllers/thing.controller.ts:10:5)',
        '    at Layer.handle (/app/node_modules/router/lib/layer.js:152:17)',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      ])
    )
    const frames = first?.stacktrace?.frames ?? []
    expect(frames.map((frame) => [frame.function, frame.in_app])).toEqual([
      ['process.processTicksAndRejections', false],
      ['Layer.handle', false],
      ['handler', true],
    ])
  })

  it('scrubs the type, the value and each frame filename and function', () => {
    const error = errorWithFrames('no account for jane@example.com', [
      '    at Object.eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl (/app/src/a.ts?token=abc:3:7)',
    ])
    error.name = 'LookupError phc_test_key_not_real'
    const [first] = exceptionListOf(error)
    expect(first?.type).toBe('LookupError [posthog-key]')
    expect(first?.value).toBe('no account for [email]')
    expect(first?.stacktrace?.frames?.[0]).toMatchObject({
      filename: '/app/src/a.ts?[query]',
      function: 'Object.[jwt]',
      lineno: 3,
      colno: 7,
    })
  })

  it('records whether the error was handled', () => {
    expect(exceptionListOf(new Error('x'), false)[0]?.mechanism?.handled).toBe(false)
    expect(exceptionListOf(new Error('x'))[0]?.mechanism?.handled).toBe(true)
  })

  it('builds from a string, a primitive and a plain object', () => {
    expect(exceptionListOf('TypeError: bad thing')[0]).toMatchObject({
      type: 'TypeError',
      value: 'bad thing',
    })
    expect(exceptionListOf(42)[0]?.value).toBe('Primitive value captured as exception: 42')
    expect(exceptionListOf({ code: 'E1' })[0]?.value).toBe(
      'Object captured as exception with keys: code'
    )
  })
})

describe('what the builder never reads', () => {
  const pgError = Object.assign(
    new postgres.PostgresError({
      message: 'duplicate key value violates unique constraint "users_email_unique"',
    } as never),
    {
      code: '23505',
      detail: 'Key (email)=(leaked.detail@example.com) already exists.',
      parameters: ['leaked-parameter-value'],
      query: 'insert into users (email) values ($1) -- leaked-query-text',
      where: 'leaked-where-context',
    }
  )

  it('drops a Postgres error’s detail, parameters, query and where', () => {
    const text = inspect(buildErrorEvent(pgError, HTTP, ERROR_ID, AT), { depth: Infinity })
    expect(text).toContain('users_email_unique')
    for (const leaked of [
      'leaked.detail',
      'leaked-parameter-value',
      'leaked-query-text',
      'leaked-where-context',
    ]) {
      expect(text).not.toContain(leaked)
    }
  })

  it('drops a failed query’s bound parameters, also as a cause and inside an object', () => {
    const wrapped = new Error('outer', { cause: fakeQueryError() })
    for (const input of [fakeQueryError(), wrapped, { error: fakeQueryError() }]) {
      const text = inspect(buildErrorEvent(input, HTTP, ERROR_ID, AT), { depth: Infinity })
      expect(text).toContain("value: 'Failed query'")
      expect(text).not.toContain('select $1')
      expect(text).not.toContain(LEAKED_PARAM)
    }
  })

  it('drops a failed query’s SQL text, which can carry inlined literals', () => {
    const error = Object.assign(new Error('Failed query: select ...'), {
      query: "select * from users where name = 'Zebulon Quixote'",
      params: [],
    })
    const { event } = buildErrorEvent(error, HTTP, ERROR_ID, AT)
    expect(JSON.stringify(event)).not.toContain('Zebulon')
    expect(exceptionListOf(error)[0]?.value).toBe('Failed query')
  })

  it('drops an HttpError’s errors', () => {
    const error = new HttpError('Validation failed', 500, undefined, [
      { field: 'email', value: 'leaked-field-value' },
    ])
    const text = inspect(buildErrorEvent(error, HTTP, ERROR_ID, AT), { depth: Infinity })
    expect(text).not.toContain('leaked-field-value')
  })
})

describe('fingerprintOf', () => {
  const site = '    at handler (/app/src/controllers/thing.controller.ts:10:5)'

  it('is the type and the innermost app frame', () => {
    const list = exceptionListOf(
      errorWithFrames('one', [site, '    at Layer.handle (/app/node_modules/router/layer.js:1:1)'])
    )
    expect(fingerprintOf(list)).toBe('Error\n/app/src/controllers/thing.controller.ts:handler:10')
  })

  it('ignores the message when an app frame exists', () => {
    const one = exceptionListOf(errorWithFrames('one', [site]))
    const two = exceptionListOf(errorWithFrames('two', [site]))
    expect(fingerprintOf(one)).toBe(fingerprintOf(two))
  })

  it('is the type and the scrubbed value without an app frame', () => {
    const list = exceptionListOf(
      errorWithFrames('mail to jane@example.com failed', [
        '    at Socket.emit (node:events:508:28)',
      ])
    )
    expect(fingerprintOf(list)).toBe('Error\nmail to [email] failed')
  })
})

describe('buildErrorEvent', () => {
  it('builds an anonymous http event, signed', () => {
    const { event } = buildErrorEvent(new Error('boom'), HTTP, ERROR_ID, AT)
    expect(event).toMatchObject({
      event: '$exception',
      uuid: ERROR_ID,
      timestamp: '2026-10-04T12:00:00.000Z',
      distinct_id: 'server:express-boilerplate',
    })
    expect(event.properties).toMatchObject({
      $exception_level: 'error',
      app: 'api',
      source: 'error',
      capture_point: 'http',
      environment: 'local',
      service: 'express-boilerplate',
      release: 'dev',
      http_method: 'GET',
      http_route: '/api/v1/things/:id',
      http_status: 500,
      request_id: 'req-1',
      $process_person_profile: false,
    })
    expect(event.properties).not.toHaveProperty('$groups')
    expect(event.properties).not.toHaveProperty('$session_id')
    expect(event.properties).not.toHaveProperty('trace_id')
    const fields = signedFieldsOf(
      { uuid: event.uuid, event: event.event, distinctId: event.distinct_id },
      event.properties
    )
    expect(fields.source).toBe('error')
    expect(isAnalyticsSignatureValid(fields, event.properties[ANALYTICS_SIGNATURE_PROPERTY])).toBe(
      true
    )
  })

  it('attributes a request’s error to its user, tenant and browser session', () => {
    const store = {
      requestId: 'req-2',
      userId: '0199a1b2-0000-7000-8000-000000000001',
      posthogSessionId: '0199a1b2-0000-7000-8000-000000000005',
      tenant: {
        tenantId: '0199a1b2-0000-7000-8000-000000000003',
        tenantSlug: 'acme',
        role: 'owner',
      },
    } as const
    const { event } = requestContextStore.run(store, () =>
      buildErrorEvent(new Error('boom'), HTTP, ERROR_ID, AT)
    )
    expect(event.distinct_id).toBe(store.userId)
    expect(event.properties).toMatchObject({
      $groups: { tenant: store.tenant.tenantId },
      $session_id: store.posthogSessionId,
    })
    expect(event.properties).not.toHaveProperty('$process_person_profile')
    const fields = signedFieldsOf(
      { uuid: event.uuid, event: event.event, distinctId: event.distinct_id },
      event.properties
    )
    expect(fields.tenant).toBe(store.tenant.tenantId)
    expect(isAnalyticsSignatureValid(fields, event.properties[ANALYTICS_SIGNATURE_PROPERTY])).toBe(
      true
    )
  })

  it('carries the active span’s trace and span ids', () => {
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    }
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(trace.wrapSpanContext(spanContext))
    const { event } = buildErrorEvent(new Error('boom'), HTTP, ERROR_ID, AT)
    expect(event.properties).toMatchObject({
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
    })
  })

  it('builds a fatal process event and a job event', () => {
    const fatal = buildErrorEvent(
      new Error('crash'),
      { capturePoint: 'process', handled: false },
      ERROR_ID,
      AT
    )
    expect(fatal.event.properties).toMatchObject({
      $exception_level: 'fatal',
      capture_point: 'process',
    })
    expect(fatal.event.properties).not.toHaveProperty('http_route')
    const job = buildErrorEvent(
      new Error('send failed'),
      {
        capturePoint: 'job',
        handled: true,
        job: { queue: 'email', name: 'send', attemptsMade: 3 },
      },
      ERROR_ID,
      AT
    )
    expect(job.event.properties).toMatchObject({
      $exception_level: 'error',
      capture_point: 'job',
      job_queue: 'email',
      job_name: 'send',
      job_attempts: 3,
    })
  })
})

describe('a failed query’s bound parameters, proven', () => {
  it('the span stand-in never carries a bound parameter', () => {
    const span = scrubbedErrorForSpan(fakeQueryError())
    expect(inspect(span, { depth: Infinity })).not.toContain(LEAKED_PARAM)
  })

  it('the event never carries a bound parameter', () => {
    const event = buildErrorEvent(fakeQueryError(), HTTP, ERROR_ID, AT)
    expect(inspect(event, { depth: Infinity })).not.toContain(LEAKED_PARAM)
  })

  /**
   * Deliberately red when run with MUTATION_PROOF=1: the event builder loads
   * against a `postgres-errors` whose `isQueryError` never matches, so a
   * failed query is treated as a plain error and its message, which carries
   * the bound parameter, is sent; the real tests' own assertion then fails.
   * Skipped by default, so the file is green:
   *
   *   MUTATION_PROOF=1 pnpm exec vitest run tests/unit/services/errors/error-event.service.test.ts   # red
   *   pnpm exec vitest run tests/unit/services/errors/error-event.service.test.ts                    # green
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces "drops a failed query’s bound parameters" against a builder that keeps them',
    async () => {
      await withMutatedModule<
        typeof import('@/errors/postgres-errors'),
        typeof import('@/services/errors/error-event.service')
      >(
        '@/errors/postgres-errors',
        { isQueryError: (_error: unknown): _error is never => false },
        () => import('@/services/errors/error-event.service'),
        (subject) => {
          const event = inspect(subject.buildErrorEvent(fakeQueryError(), HTTP, ERROR_ID, AT), {
            depth: Infinity,
          })
          const span = inspect(subject.scrubbedErrorForSpan(fakeQueryError()), { depth: Infinity })
          expect(event).not.toContain(LEAKED_PARAM)
          expect(span).not.toContain(LEAKED_PARAM)
        }
      )
    }
  )
})

describe('scrubbedErrorForSpan', () => {
  it('carries only scrubbed text', () => {
    const error = errorWithFrames('no account for jane@example.com', [
      '    at lookup (/app/src/a.ts?token=abc:3:7)',
    ])
    expect(scrubbedErrorForSpan(error)).toEqual({
      name: 'Error',
      message: 'no account for [email]',
      stack: 'Error: no account for [email]\n    at lookup (/app/src/a.ts?[query]:3:7)',
    })
  })

  it('drops a failed query’s parameters', () => {
    const text = inspect(scrubbedErrorForSpan(fakeQueryError()), { depth: Infinity })
    expect(text).not.toContain(LEAKED_PARAM)
  })

  it('has no stack for a value that is not an Error', () => {
    expect(scrubbedErrorForSpan('plain jane@example.com')).toEqual({
      name: 'Error',
      message: 'plain [email]',
    })
  })

  it('never throws on an error that throws when read', () => {
    const hostile = new Proxy(new Error('x'), {
      get: () => {
        throw new Error('read refused')
      },
    })
    expect(scrubbedErrorForSpan(hostile)).toEqual({ name: 'Error', message: 'Unreadable error' })
  })
})
