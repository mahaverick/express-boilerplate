// tests/unit/presenters/audit.presenter.test.ts
import { describe, expect, it } from 'vitest'
import type { AuditLog } from '@/database/models/audit-log.model'
import { toAuditEntry, toPlatformAuditEntry } from '@/presenters/audit.presenter'

const occurredAt = new Date('2026-09-25T10:00:00.123Z')
const base = {
  id: 'entry-1',
  occurredAt,
  actorKind: 'user',
  actorUserId: 'user-1',
  access: 'platform',
  tenantId: 'tenant-1',
  action: 'tenant.updated',
  targetType: 'tenant',
  targetId: 'tenant-1',
  metadata: { changed: ['name'] },
  requestId: 'req-1',
  ip: '203.0.113.5',
  userAgent: 'agent',
} as unknown as AuditLog
const tenant = { id: 'tenant-1', name: 'Acme', slug: 'acme' }

describe('toAuditEntry', () => {
  it('sends the contract fields only, never ip, user agent or request id', () => {
    const entry = toAuditEntry({
      entry: base,
      actor: { id: 'user-1', email: 'sam@staff.example', firstName: 'Sam', lastName: 'Staff' },
      tenant,
    })

    expect(entry).toEqual({
      id: 'entry-1',
      occurredAt,
      action: 'tenant.updated',
      access: 'platform',
      actor: { id: 'user-1', name: 'Sam Staff', email: 'sam@staff.example' },
      target: { type: 'tenant', id: 'tenant-1' },
      metadata: { changed: ['name'] },
    })
  })

  it('names an actor with no first or last name by their email', () => {
    const entry = toAuditEntry({
      entry: base,
      // eslint-disable-next-line unicorn/no-null -- the users columns are nullable
      actor: { id: 'user-1', email: 'anon@example.test', firstName: null, lastName: '' },
      tenant,
    })

    expect(entry.actor?.name).toBe('anon@example.test')
  })

  it('answers a null actor for a system entry and a null target when none is set', () => {
    const system = {
      ...base,
      actorKind: 'system',
      // eslint-disable-next-line unicorn/no-null -- a system entry has no actor
      actorUserId: null,
      access: 'system',
      // eslint-disable-next-line unicorn/no-null -- no target
      targetType: null,
      // eslint-disable-next-line unicorn/no-null -- no target
      targetId: null,
    } as unknown as AuditLog

    // eslint-disable-next-line unicorn/no-null -- the left join found no user
    const entry = toAuditEntry({ entry: system, actor: null, tenant })

    expect(entry.actor).toBeNull()
    expect(entry.target).toBeNull()
  })
})

describe('toPlatformAuditEntry', () => {
  it('adds the tenant', () => {
    // eslint-disable-next-line unicorn/no-null -- a system entry has no actor
    const entry = toPlatformAuditEntry({ entry: base, actor: null, tenant })

    expect(entry.tenant).toEqual(tenant)
  })
})
