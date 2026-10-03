/**
 * @file The posthogSession middleware, called directly inside a request
 * context the way requestContext opens one: a single UUID header lands on
 * the context, anything else is dropped, and the chain always continues.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { posthogSession } from '@/middlewares/posthog-session.middleware'
import { requestContextStore, type RequestContext } from '@/services/request-context.service'

const SESSION_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

/**
 * Run the middleware inside a fresh request context.
 * @param header - The `x-posthog-session-id` header value, if any.
 * @returns The context after the middleware ran, and whether it called next.
 */
function run(header: string | undefined): {
  context: RequestContext
  isNextCalled: boolean
} {
  const context: RequestContext = { requestId: 'req-posthog-1' }
  const headers = header === undefined ? {} : { 'x-posthog-session-id': header }
  let isNextCalled = false
  requestContextStore.run(context, () => {
    posthogSession({ headers } as unknown as Request, {} as never, () => {
      isNextCalled = true
    })
  })
  return { context, isNextCalled }
}

describe('posthogSession middleware', () => {
  it('records a UUID session id on the request context', () => {
    const { context, isNextCalled } = run(SESSION_ID)
    expect(context.posthogSessionId).toBe(SESSION_ID)
    expect(isNextCalled).toBe(true)
  })

  it('accepts an upper-case UUID as sent', () => {
    expect(run(SESSION_ID.toUpperCase()).context.posthogSessionId).toBe(SESSION_ID.toUpperCase())
  })

  it.each([
    ['an empty value', ''],
    ['a non-UUID', 'session-1'],
    ['a UUID with a trailing newline', `${SESSION_ID}\n`],
    ['a repeated header, which Node joins with a comma', `${SESSION_ID}, ${SESSION_ID}`],
    ['a UUID without dashes', SESSION_ID.replaceAll('-', '')],
  ])('drops %s and still continues', (_label, value) => {
    const { context, isNextCalled } = run(value)
    expect(context).not.toHaveProperty('posthogSessionId')
    expect(isNextCalled).toBe(true)
  })

  it('leaves the context alone when the header is absent', () => {
    expect(run(undefined).context).toEqual({ requestId: 'req-posthog-1' })
  })

  it('continues when there is no request context at all', () => {
    let isNextCalled = false
    posthogSession(
      { headers: { 'x-posthog-session-id': SESSION_ID } } as unknown as Request,
      {} as never,
      () => {
        isNextCalled = true
      }
    )
    expect(isNextCalled).toBe(true)
  })
})
