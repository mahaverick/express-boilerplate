// tests/unit/middlewares/request-context.middleware.test.ts
//
// No Express app, no Docker — just the middleware function and the store it
// populates, called directly the way content-type.middleware.test.ts and
// error.middleware.test.ts call their middlewares (see CLAUDE.md on why a
// Docker-dependent test must never live under tests/unit/).
import { type Request } from 'express'
import { describe, expect, it } from 'vitest'
import { requestContext, requestContextStore } from '@/middlewares/request-context.middleware'

describe('requestContext middleware', () => {
  it('sets requestId in the store from request.id', () => {
    const request = { id: 'test-uuid-1234' } as unknown as Request
    let capturedRequestId: string | undefined

    requestContext(request, {} as never, () => {
      capturedRequestId = requestContextStore.getStore()?.requestId
    })

    expect(capturedRequestId).toBe('test-uuid-1234')
  })

  it('returns undefined from getStore() outside a request context', () => {
    expect(requestContextStore.getStore()).toBeUndefined()
  })

  it('isolates contexts between concurrent requests', async () => {
    const results: string[] = []

    await Promise.all([
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-a' } as unknown as Request, {} as never, () => {
          setTimeout(() => {
            const store = requestContextStore.getStore()
            if (store) results.push(store.requestId)
            resolve()
          }, 10)
        })
      }),
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-b' } as unknown as Request, {} as never, () => {
          const store = requestContextStore.getStore()
          if (store) results.push(store.requestId)
          resolve()
        })
      }),
    ])

    expect(results).toContain('req-a')
    expect(results).toContain('req-b')
  })
})
