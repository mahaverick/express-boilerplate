/**
 * @file Unit tests for the controller request accessors that need no
 * database: `oauthIntentOf` reads the stored Google intent and never trusts
 * it, falling back to a plain web sign-in.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vite-plus/test'
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
    [
      'a step-up stored before Google step-up was removed',
      { kind: 'step_up', userId: 'u', sessionId: 's', startedAt: 1_900_000_000_000 },
      WEB_SIGN_IN,
    ],
    ['a non-object', 'apex', WEB_SIGN_IN],
    [
      'an off-origin redirect',
      { kind: 'sign_in', app: 'apex', redirect: '//evil.test' },
      { kind: 'sign_in', app: 'apex' },
    ],
  ])('answers a safe intent for a tampered session value: %s', (_label, stored, expected) => {
    expect(oauthIntentOf(requestWithSession({ oauthIntent: stored }))).toEqual(expected)
  })
})
