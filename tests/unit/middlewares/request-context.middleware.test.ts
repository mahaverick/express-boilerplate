// tests/unit/middlewares/request-context.middleware.test.ts
//
// No Express app, no Docker — just the middleware function and the store it
// populates, called directly the way content-type.middleware.test.ts and
// error.middleware.test.ts call their middlewares (see CLAUDE.md on why a
// Docker-dependent test must never live under tests/unit/).
import { type Request } from 'express'
import { describe, expect, it } from 'vitest'
import { requestContext } from '@/middlewares/request-context.middleware'
import { requestContextStore } from '@/services/request-context.service'

describe('requestContext middleware', () => {
  it('sets requestId in the store from request.id', () => {
    const request = { id: 'test-uuid-1234', headers: {} } as unknown as Request
    let capturedRequestId: string | undefined

    requestContext(request, {} as never, () => {
      capturedRequestId = requestContextStore.getStore()?.requestId
    })

    expect(capturedRequestId).toBe('test-uuid-1234')
  })

  it('carries the client address and user agent for the audit log', () => {
    const request = {
      id: 'test-uuid-5678',
      ip: '203.0.113.7',
      headers: { 'user-agent': 'Probe/1.0' },
    } as unknown as Request
    let captured: ReturnType<typeof requestContextStore.getStore>

    requestContext(request, {} as never, () => {
      captured = requestContextStore.getStore()
    })

    expect(captured).toEqual({
      requestId: 'test-uuid-5678',
      ip: '203.0.113.7',
      userAgent: 'Probe/1.0',
    })
  })

  it('omits the address and user agent when the request has neither', () => {
    let captured: ReturnType<typeof requestContextStore.getStore>

    requestContext({ id: 'req-bare', headers: {} } as unknown as Request, {} as never, () => {
      captured = requestContextStore.getStore()
    })

    expect(captured).toEqual({ requestId: 'req-bare' })
  })

  it('returns undefined from getStore() outside a request context', () => {
    expect(requestContextStore.getStore()).toBeUndefined()
  })

  it('isolates contexts between concurrent requests', async () => {
    const results: string[] = []

    await Promise.all([
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-a', headers: {} } as unknown as Request, {} as never, () => {
          setTimeout(() => {
            const store = requestContextStore.getStore()
            if (store) results.push(store.requestId)
            resolve()
          }, 10)
        })
      }),
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-b', headers: {} } as unknown as Request, {} as never, () => {
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
