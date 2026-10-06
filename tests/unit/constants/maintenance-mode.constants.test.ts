/**
 * @file `maintenanceVerdict` against spec §4.3's tables, mode by mode: the
 * always-let-through set, the auth routes, reads, writes, the read-only
 * allowlist, OPTIONS, an unknown path, and how a path is matched (HEAD as
 * GET, case, trailing slash, a parameter segment).
 */
import { describe, expect, it } from 'vitest'
import {
  classifyMaintenanceRoute,
  MAINTENANCE_MODE_CODE,
  maintenanceVerdict,
  READ_ONLY_MODE_CODE,
} from '@/constants/maintenance-mode.constants'

const ALWAYS: [string, string][] = [
  ['GET', '/health'],
  ['GET', '/health/ready'],
  ['POST', '/api/v1/webhooks/email/resend'],
  ['POST', '/api/v1/collect/e/'],
  ['GET', '/api/v1/collect/static/array.js'],
  ['GET', '/api/v1/status/maintenance'],
  ['GET', '/api/v1/platform/tenants'],
  ['POST', '/api/v1/platform/tenants/0190a8e2-0000-7000-8000-000000000001/suspend'],
  ['PUT', '/api/v1/platform/maintenance-mode'],
  ['POST', '/api/v1/platform/me/flags/exposures'],
  ['POST', '/api/v1/auth/login'],
  ['GET', '/api/v1/auth/google'],
  ['GET', '/api/v1/auth/google/callback'],
  ['POST', '/api/v1/auth/refresh'],
  ['POST', '/api/v1/auth/logout'],
  ['POST', '/api/v1/auth/reauthenticate'],
  ['GET', '/api/v1/auth/providers'],
  ['GET', '/api/v1/profile'],
]

const AUTH_WRITES = [
  '/api/v1/auth/register',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/change-password',
]

const READS = [
  '/api/v1/notifications',
  '/api/v1/notifications/stream',
  '/api/v1/tenants/acme',
  '/api/v1/tenants/acme/members',
  '/api/v1/flags',
]

const WRITES: [string, string][] = [
  ['PATCH', '/api/v1/profile'],
  ['POST', '/api/v1/tenants'],
  ['PATCH', '/api/v1/tenants/acme/settings'],
  ['DELETE', '/api/v1/tenants/acme/members/0190a8e2-0000-7000-8000-000000000001'],
  ['PUT', '/api/v1/notifications/preferences'],
  ['POST', '/api/v1/invitations/accept'],
]

const EXPOSURES = ['/api/v1/flags/exposures', '/api/v1/tenants/acme/flags/exposures']

describe('maintenanceVerdict', () => {
  it.each([...ALWAYS, ...WRITES])('lets %s %s through while off', (method, path) => {
    expect(maintenanceVerdict('off', method, path)).toBe('allow')
  })

  it.each(ALWAYS)('lets %s %s through in both modes', (method, path) => {
    expect(maintenanceVerdict('read_only', method, path)).toBe('allow')
    expect(maintenanceVerdict('full', method, path)).toBe('allow')
  })

  it.each(AUTH_WRITES)('refuses POST %s in both modes, each with its code', (path) => {
    expect(maintenanceVerdict('read_only', 'POST', path)).toBe(READ_ONLY_MODE_CODE)
    expect(maintenanceVerdict('full', 'POST', path)).toBe(MAINTENANCE_MODE_CODE)
  })

  it.each(READS)('lets GET %s through in read_only and refuses it in full', (path) => {
    expect(maintenanceVerdict('read_only', 'GET', path)).toBe('allow')
    expect(maintenanceVerdict('full', 'GET', path)).toBe(MAINTENANCE_MODE_CODE)
  })

  it.each(WRITES)('refuses %s %s in both modes', (method, path) => {
    expect(maintenanceVerdict('read_only', method, path)).toBe(READ_ONLY_MODE_CODE)
    expect(maintenanceVerdict('full', method, path)).toBe(MAINTENANCE_MODE_CODE)
  })

  it.each(EXPOSURES)('lets POST %s through in read_only only (the allowlist)', (path) => {
    expect(maintenanceVerdict('read_only', 'POST', path)).toBe('allow')
    expect(maintenanceVerdict('full', 'POST', path)).toBe(MAINTENANCE_MODE_CODE)
  })

  it('lets OPTIONS through on any path in both modes', () => {
    expect(maintenanceVerdict('full', 'OPTIONS', '/api/v1/tenants')).toBe('allow')
    expect(maintenanceVerdict('read_only', 'OPTIONS', '/api/v1/tenants/acme')).toBe('allow')
  })

  it('gives an unknown path the default: reads through in read_only, everything refused in full', () => {
    expect(maintenanceVerdict('read_only', 'GET', '/api/v1/nothing-here')).toBe('allow')
    expect(maintenanceVerdict('read_only', 'POST', '/api/v1/nothing-here')).toBe(
      READ_ONLY_MODE_CODE
    )
    expect(maintenanceVerdict('full', 'GET', '/api/v1/nothing-here')).toBe(MAINTENANCE_MODE_CODE)
  })

  it('matches as Express routes: HEAD as GET, any case, an optional trailing slash', () => {
    expect(maintenanceVerdict('full', 'HEAD', '/health')).toBe('allow')
    expect(maintenanceVerdict('full', 'get', '/HEALTH/')).toBe('allow')
    expect(maintenanceVerdict('full', 'POST', '/API/V1/Platform/tenants')).toBe('allow')
    expect(maintenanceVerdict('read_only', 'POST', '/api/v1/flags/exposures/')).toBe('allow')
  })

  it('never lets a lookalike of an always-through prefix through', () => {
    expect(maintenanceVerdict('full', 'GET', '/api/v1/platform-tools')).toBe(MAINTENANCE_MODE_CODE)
    expect(maintenanceVerdict('full', 'GET', '/api/v1/collector')).toBe(MAINTENANCE_MODE_CODE)
    expect(maintenanceVerdict('full', 'GET', '/healthz')).toBe(MAINTENANCE_MODE_CODE)
    expect(maintenanceVerdict('full', 'POST', '/health')).toBe(MAINTENANCE_MODE_CODE)
  })

  it('matches a parameter as exactly one segment', () => {
    expect(maintenanceVerdict('read_only', 'POST', '/api/v1/tenants/acme/flags/exposures')).toBe(
      'allow'
    )
    expect(maintenanceVerdict('read_only', 'POST', '/api/v1/tenants/a/b/flags/exposures')).toBe(
      READ_ONLY_MODE_CODE
    )
  })

  it('marks the routes apex calls as staff-pass, and no other', () => {
    expect(classifyMaintenanceRoute('PATCH', '/api/v1/tenants/acme')?.staffPass).toBe(true)
    expect(classifyMaintenanceRoute('GET', '/api/v1/tenants/acme/members')?.staffPass).toBe(true)
    expect(classifyMaintenanceRoute('POST', '/api/v1/invitations/accept')?.staffPass).toBe(true)
    expect(classifyMaintenanceRoute('GET', '/api/v1/notifications')?.staffPass).toBe(false)
    expect(classifyMaintenanceRoute('POST', '/api/v1/auth/register')?.staffPass).toBe(false)
  })
})
