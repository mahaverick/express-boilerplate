/**
 * @file `findMailpitMessages` takes its base URL from `MAILPIT_URL`, so an
 * isolated Mailpit can be targeted without touching the compose stack's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findMailpitMessages } from '../../helpers/mailpit'

/**
 * Stub `fetch` with a one-message search result and return the spy.
 * @returns The stubbed fetch.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: () => ({ messages: [{ ID: 'm1' }] }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('findMailpitMessages base URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('defaults to the compose stack on localhost:8025', async () => {
    vi.stubEnv('MAILPIT_URL', undefined)
    const fetchMock = stubFetch()
    await findMailpitMessages('x@example.test')
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^http:\/\/localhost:8025\/api\/v1\/search\?/
    )
  })

  it('uses MAILPIT_URL with a single slash before /api/v1', async () => {
    vi.stubEnv('MAILPIT_URL', 'http://127.0.0.1:18025/')
    const fetchMock = stubFetch()
    await findMailpitMessages('x@example.test')
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^http:\/\/127\.0\.0\.1:18025\/api\/v1\/search\?/
    )
  })
})
