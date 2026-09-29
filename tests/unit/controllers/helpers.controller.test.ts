/**
 * @file Unit tests for the controller request accessors that need no
 * database: `oauthAppOf` reads the stored frontend and never trusts it.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { oauthAppOf } from '@/controllers/helpers.controller'

function requestWithSession(session: Record<string, unknown>): Request {
  return { session } as unknown as Request
}

describe('oauthAppOf', () => {
  it('answers web when there is no session', () => {
    expect(oauthAppOf({} as Request)).toBe('web')
  })

  it('answers web when the session holds no app', () => {
    expect(oauthAppOf(requestWithSession({}))).toBe('web')
  })

  it('answers the stored app', () => {
    expect(oauthAppOf(requestWithSession({ oauthApp: 'apex' }))).toBe('apex')
  })

  it('answers web for a tampered session value', () => {
    expect(oauthAppOf(requestWithSession({ oauthApp: 'https://evil.example' }))).toBe('web')
  })
})
