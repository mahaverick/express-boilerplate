import { beforeEach, describe, expect, it, vi } from 'vitest'

async function load(webUrl: string, allowed?: string) {
  vi.doMock('@/configs/env.config', () => ({
    getEnv: () => ({ WEB_URL: webUrl, CORS_ALLOWED_ORIGINS: allowed }),
  }))
  const module = await import('@/utilities/origin.utilities')
  return module.isAllowedOrigin
}

describe('isAllowedOrigin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('allows a request with no Origin header, which is what same-origin sends', async () => {
    const isAllowedOrigin = await load('http://localhost:5173')
    expect(isAllowedOrigin(undefined)).toBe(true)
  })

  it('always allows WEB_URL, even when the allowlist is empty', async () => {
    // Load-bearing for a PRODUCTION cross-origin deployment
    // (app.example.com calling api.example.com), not the dev proxy: under
    // Vite the page and the request are both localhost:5173, so the browser
    // applies no CORS check at all regardless of this function's result.
    const isAllowedOrigin = await load('http://localhost:5173')
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
  })

  it('matches a browser-style origin even when WEB_URL has a trailing slash', async () => {
    // z.url() accepts "https://app.example.com/", but a browser's Origin
    // header never carries a trailing slash — an uncanonicalized comparison
    // here would reject every request from the primary frontend.
    const isAllowedOrigin = await load('https://app.example.com/')
    expect(isAllowedOrigin('https://app.example.com')).toBe(true)
  })

  it('matches a browser-style origin even when a CORS_ALLOWED_ORIGINS entry has a trailing slash', async () => {
    const isAllowedOrigin = await load('https://app.example.com', 'https://admin.example.com/')
    expect(isAllowedOrigin('https://admin.example.com')).toBe(true)
  })

  it('allows each entry in CORS_ALLOWED_ORIGINS', async () => {
    const isAllowedOrigin = await load(
      'https://app.example.com',
      'https://admin.example.com, https://shop.example.com'
    )
    expect(isAllowedOrigin('https://admin.example.com')).toBe(true)
    expect(isAllowedOrigin('https://shop.example.com')).toBe(true)
  })

  it('rejects anything else', async () => {
    const isAllowedOrigin = await load('https://app.example.com', 'https://admin.example.com')
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
  })

  it('rejects a lookalike that merely shares a suffix', async () => {
    const isAllowedOrigin = await load('https://app.example.com')
    expect(isAllowedOrigin('https://app.example.com.evil.test')).toBe(false)
  })
})
