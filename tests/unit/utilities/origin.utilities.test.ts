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
    // Load-bearing: Vite's dev proxy forwards Origin on POST, so without this
    // every login in development fails CORS while GETs keep working.
    const isAllowedOrigin = await load('http://localhost:5173')
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
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
