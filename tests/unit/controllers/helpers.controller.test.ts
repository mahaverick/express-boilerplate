/**
 * @file Unit tests for the controller request accessors that need no
 * database: `oauthIntentOf` reads the stored Google intent and never trusts
 * it, falling back to a plain web sign-in, except that a stored step-up never
 * reads as a sign-in, however it was tampered with.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { oauthIntentOf } from '@/controllers/helpers.controller'

/**
 * A request carrying only the given session, which is all `oauthIntentOf` reads.
 */
function requestWithSession(session: Record<string, unknown>): Request {
  return { session } as unknown as Request
}

const WEB_SIGN_IN = { kind: 'sign_in', app: 'web' }

describe('oauthIntentOf', () => {
  it('answers a web sign-in when there is no session', () => {
    expect(oauthIntentOf({} as Request)).toEqual(WEB_SIGN_IN)
  })

  it('answers a web sign-in when the session holds no intent', () => {
    expect(oauthIntentOf(requestWithSession({}))).toEqual(WEB_SIGN_IN)
  })

  it('answers the stored intent', () => {
    expect(
      oauthIntentOf(
        requestWithSession({ oauthIntent: { kind: 'sign_in', app: 'apex', redirect: '/a?b=c' } })
      )
    ).toEqual({ kind: 'sign_in', app: 'apex', redirect: '/a?b=c' })
  })

  it.each([
    ['an unknown app', { kind: 'sign_in', app: 'https://evil.example' }, WEB_SIGN_IN],
    ['an unknown kind', { kind: 'other', app: 'apex' }, WEB_SIGN_IN],
    ['a non-object', 'apex', WEB_SIGN_IN],
    [
      'an off-origin redirect',
      { kind: 'sign_in', app: 'apex', redirect: '//evil.test' },
      { kind: 'sign_in', app: 'apex' },
    ],
  ])('answers a safe intent for a tampered session value: %s', (_label, stored, expected) => {
    expect(oauthIntentOf(requestWithSession({ oauthIntent: stored }))).toEqual(expected)
  })

  describe('a stored step-up', () => {
    const STEP_UP = {
      kind: 'step_up',
      userId: '0190a8e2-0000-7000-8000-000000000001',
      sessionId: '0190a8e2-0000-7000-8000-000000000002',
      startedAt: 1_900_000_000_000,
    }

    it('answers the stored step-up', () => {
      expect(oauthIntentOf(requestWithSession({ oauthIntent: STEP_UP }))).toEqual(STEP_UP)
    })

    it('drops fields a step-up does not carry', () => {
      expect(
        oauthIntentOf(
          requestWithSession({ oauthIntent: { ...STEP_UP, app: 'web', redirect: '/x' } })
        )
      ).toEqual(STEP_UP)
    })

    it.each([
      ['a missing userId', { ...STEP_UP, userId: undefined }],
      ['a numeric userId', { ...STEP_UP, userId: 7 }],
      ['an empty sessionId', { ...STEP_UP, sessionId: '' }],
      ['a missing sessionId', { ...STEP_UP, sessionId: undefined }],
      ['a string startedAt', { ...STEP_UP, startedAt: '1900000000000' }],
      ['a non-finite startedAt', { ...STEP_UP, startedAt: Infinity }],
      ['a missing startedAt', { ...STEP_UP, startedAt: undefined }],
    ])('never reads a malformed step-up as a sign-in: %s', (_label, stored) => {
      expect(oauthIntentOf(requestWithSession({ oauthIntent: stored }))).toEqual({
        kind: 'invalid_step_up',
      })
    })
  })
})
