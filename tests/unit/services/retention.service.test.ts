// tests/unit/services/retention.service.test.ts
//
// The pure half of the retention purge: the batch size, and how the
// environment maps to each rule's days. The purge itself runs against
// Postgres in tests/integration/services/retention.service.test.ts.
import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/configs/env.config'
import { RETENTION_BATCH_SIZE, retentionDays } from '@/services/retention.service'

describe('retention.service', () => {
  it('deletes in batches of 5000', () => {
    expect(RETENTION_BATCH_SIZE).toBe(5000)
  })

  it('maps each RETENTION_*_DAYS variable to its rule', () => {
    const env = parseEnv({
      APP_ENV: 'local',
      NODE_ENV: 'test',
      APP_URL: 'http://localhost:4040',
      WEB_URL: 'http://localhost:5173',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      SESSION_SECRET: 'c'.repeat(32),
      RETENTION_TOKENS_DAYS: '1',
      RETENTION_INVITATIONS_DAYS: '2',
      RETENTION_EMAIL_LOGS_DAYS: '3',
      RETENTION_NOTIFICATIONS_READ_DAYS: '4',
      RETENTION_NOTIFICATIONS_UNREAD_DAYS: '5',
      RETENTION_AUDIT_LOGS_DAYS: '6',
    })
    expect(retentionDays(env)).toEqual({
      tokens: 1,
      invitations: 2,
      emailLogs: 3,
      notificationsRead: 4,
      notificationsUnread: 5,
      auditLogs: 6,
    })
  })
})
