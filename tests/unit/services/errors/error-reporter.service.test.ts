/**
 * @file The capture rule `errorHandler` applies to a 5xx: an unexpected
 * error, a deliberate HttpError with and without a cause,
 * TimelineUnavailableError, and anything below 500.
 */
import { describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import { shouldCaptureHttpError } from '@/services/errors/error-reporter.service'

describe('shouldCaptureHttpError', () => {
  it('captures an unexpected error at 500', () => {
    expect(shouldCaptureHttpError(new Error('boom'), 500)).toBe(true)
  })

  it('skips a deliberate HttpError at 503 without a cause', () => {
    expect(shouldCaptureHttpError(new HttpError('Server is shutting down', 503), 503)).toBe(false)
  })

  it('captures an HttpError at 503 that wraps a cause', () => {
    const error = new HttpError('Upstream failed', 503)
    Object.assign(error, { cause: new Error('socket hang up') })
    expect(shouldCaptureHttpError(error, 503)).toBe(true)
  })

  it('never captures TimelineUnavailableError, even with a cause', () => {
    const error = new TimelineUnavailableError()
    Object.assign(error, { cause: new Error('PostHog 500') })
    expect(shouldCaptureHttpError(error, 502)).toBe(false)
  })

  it('never captures below 500', () => {
    expect(shouldCaptureHttpError(new Error('boom'), 499)).toBe(false)
    expect(shouldCaptureHttpError(new HttpError('Not found', 404), 404)).toBe(false)
  })
})
