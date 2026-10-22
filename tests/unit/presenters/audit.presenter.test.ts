import { describe, expect, it } from 'vite-plus/test'
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
      actor: { id: 'user-1', email: 'anon@example.test', firstName: null, lastName: '' },
      tenant,
    })

    expect(entry.actor?.name).toBe('anon@example.test')
  })

  it('answers a null actor for a system entry and a null target when none is set', () => {
    const system = {
      ...base,
      actorKind: 'system',
      actorUserId: null,
      access: 'system',
      targetType: null,
      targetId: null,
    } as unknown as AuditLog

    const entry = toAuditEntry({ entry: system, actor: null, tenant })

    expect(entry.actor).toBeNull()
    expect(entry.target).toBeNull()
  })
})

describe('toPlatformAuditEntry', () => {
  it('adds the tenant', () => {
    const entry = toPlatformAuditEntry({ entry: base, actor: null, tenant })

    expect(entry.tenant).toEqual(tenant)
  })
})
