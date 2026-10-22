/**
 * @file The two audit-log list schemas: the tenant read takes an actor and
 * an access list beside the action list, and only the platform read takes a
 * tenant and a target.
 */
import { describe, expect, it } from 'vite-plus/test'
import { platformAuditLogListSchema, tenantAuditLogListSchema } from '@/validators/audit.validators'

const ID = '0199c4a2-0000-7000-8000-000000000001'

describe('tenantAuditLogListSchema', () => {
  it('takes an action list, one actor and an access list', () => {
    expect(
      tenantAuditLogListSchema.parse({
        action: 'tenant.updated,tenant.created',
        actor: ID,
        access: 'platform,member',
      }).filters
    ).toEqual({
      action: ['tenant.created', 'tenant.updated'],
      actor: ID,
      access: ['member', 'platform'],
    })
  })

  it('refuses an actor that is not a uuid and an unknown access path', () => {
    expect(tenantAuditLogListSchema.safeParse({ actor: 'someone' }).success).toBe(false)
    expect(tenantAuditLogListSchema.safeParse({ access: 'root' }).success).toBe(false)
  })

  it('has no tenant or target filter', () => {
    expect(
      Object.keys(tenantAuditLogListSchema.parse({ tenant: ID, target: ID }).filters).toSorted(
        (a, b) => a.localeCompare(b)
      )
    ).toEqual(['access', 'action', 'actor'])
  })

  it('sorts newest first unless asked', () => {
    expect(tenantAuditLogListSchema.parse({}).params.sort).toBe('-occurred')
  })
})

describe('platformAuditLogListSchema', () => {
  it('adds one tenant and one target to the tenant filters', () => {
    expect(
      platformAuditLogListSchema.parse({ tenant: ID, target: ID, actor: ID }).filters
    ).toMatchObject({
      tenant: ID,
      target: ID,
      actor: ID,
    })
  })
})
