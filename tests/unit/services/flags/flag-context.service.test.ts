/**
 * @file buildFlagContext: the trait values, day counts and the tenant group,
 * with and without a tenant.
 */
import { describe, expect, it } from 'vitest'
import { buildFlagContext } from '@/services/flags/flag-context.service'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const USER_ID = '0199b000-0000-7000-8000-000000000001'
const TENANT_ID = '0199b000-0000-7000-8000-000000000002'
const SESSION_ID = '0199b000-0000-7000-8000-000000000003'
// eslint-disable-next-line unicorn/no-null -- the input's contract uses null for "none"
const NONE = null

describe('buildFlagContext', () => {
  it('builds a tenant context with person traits, the tenant group and its day count', () => {
    expect(
      buildFlagContext({
        userId: USER_ID,
        tenantId: TENANT_ID,
        platformRole: NONE,
        tenantRole: 'editor',
        userCreatedAt: new Date('2026-09-05T12:00:00.000Z'),
        tenantCreatedAt: new Date('2026-07-07T11:59:59.000Z'),
        sessionId: SESSION_ID,
        now: NOW,
        appEnv: 'qa',
      })
    ).toEqual({
      distinctId: USER_ID,
      groups: { tenant: TENANT_ID },
      personProps: {
        platform_role: 'none',
        tenant_role: 'editor',
        app_env: 'qa',
        account_created_days: 30,
      },
      groupProps: { tenant: { tenant_created_days: 90 } },
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
    })
  })

  it('builds a tenantless context: tenant_role none, no group, no group traits', () => {
    const context = buildFlagContext({
      userId: USER_ID,
      tenantId: NONE,
      platformRole: 'admin',
      tenantRole: NONE,
      userCreatedAt: NOW,
      tenantCreatedAt: NONE,
      sessionId: NONE,
      now: NOW,
      appEnv: 'prod',
    })
    expect(context).toEqual({
      distinctId: USER_ID,
      groups: {},
      personProps: {
        platform_role: 'admin',
        tenant_role: 'none',
        app_env: 'prod',
        account_created_days: 0,
      },
      groupProps: {},
      tenantId: NONE,
      sessionId: NONE,
    })
    expect(Object.keys(context.groups)).toEqual([])
  })

  it('gives tenant_role none for a tenant the user is not a member of, and no day count for an unknown tenant creation', () => {
    const context = buildFlagContext({
      userId: USER_ID,
      tenantId: TENANT_ID,
      platformRole: 'viewer',
      tenantRole: NONE,
      userCreatedAt: NOW,
      tenantCreatedAt: NONE,
      sessionId: NONE,
      now: NOW,
      appEnv: 'local',
    })
    expect(context.personProps.tenant_role).toBe('none')
    expect(context.groups).toEqual({ tenant: TENANT_ID })
    expect(context.groupProps).toEqual({ tenant: {} })
  })

  it('clamps a creation time in the future to 0 days', () => {
    const context = buildFlagContext({
      userId: USER_ID,
      tenantId: TENANT_ID,
      platformRole: NONE,
      tenantRole: 'owner',
      userCreatedAt: new Date(NOW.getTime() + 86_400_000),
      tenantCreatedAt: new Date(NOW.getTime() + 86_400_000),
      sessionId: NONE,
      now: NOW,
      appEnv: 'local',
    })
    expect(context.personProps.account_created_days).toBe(0)
    expect(context.groupProps.tenant).toEqual({ tenant_created_days: 0 })
  })

  it('reads app_env from APP_ENV when none is passed', () => {
    const context = buildFlagContext({
      userId: USER_ID,
      tenantId: NONE,
      platformRole: NONE,
      tenantRole: NONE,
      userCreatedAt: NOW,
      tenantCreatedAt: NONE,
      sessionId: NONE,
      now: NOW,
    })
    expect(context.personProps.app_env).toBe('local')
  })
})
