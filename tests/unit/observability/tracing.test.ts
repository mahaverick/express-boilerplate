// tests/unit/observability/tracing.test.ts
//
// The real branch of this module — OTEL_EXPORTER_OTLP_ENDPOINT set, a real
// NodeSDK built and started — is process bootstrap wiring loaded via
// `--import`, before any test framework is attached (see that module's own
// header comment and vitest.config.ts's coverage exclusion for it). It is
// not meaningfully unit-testable, the same reasoning src/index.ts's own
// exclusion already applies in this repo.
//
// What IS testable, and worth pinning, is the no-op path: .env.test (loaded
// by tests/helpers/setup-global.ts before this file's own imports run) does
// not set OTEL_EXPORTER_OTLP_ENDPOINT, so importing this module here always
// exercises the "tracing disabled" branch — same as every other test file
// that transitively imports it.
import { describe, expect, it } from 'vitest'
import { shutdownOtel, tracingResourceAttributes } from '@/observability/tracing'

describe('tracing (OTEL_EXPORTER_OTLP_ENDPOINT unset, the test-env default)', () => {
  it('imports without throwing', () => {
    // The import itself, at the top of this file, is the real assertion —
    // if module-scope evaluation threw, this whole file would fail to load
    // rather than reach this test. Re-asserting `shutdownOtel` is a function
    // here gives that a named, visible check instead of an implicit one.
    expect(typeof shutdownOtel).toBe('function')
  })

  it('shutdownOtel() resolves without error when no SDK was ever started', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
})

describe('tracingResourceAttributes', () => {
  it('reports APP_ENV as deployment.environment.name', () => {
    expect(tracingResourceAttributes({ APP_ENV: 'qa' })['deployment.environment.name']).toBe('qa')
  })

  // Tracing runs before env validation, so an unset APP_ENV reports nothing
  // rather than a guess, and NODE_ENV is never used in its place.
  it('omits deployment.environment.name when APP_ENV is unset, whatever NODE_ENV says', () => {
    expect(Object.keys(tracingResourceAttributes({ NODE_ENV: 'production' }))).toEqual([
      'service.name',
    ])
  })

  it('reports OTEL_SERVICE_NAME, defaulting to express-boilerplate', () => {
    expect(tracingResourceAttributes({})['service.name']).toBe('express-boilerplate')
    expect(tracingResourceAttributes({ OTEL_SERVICE_NAME: 'billing' })['service.name']).toBe(
      'billing'
    )
  })
})
