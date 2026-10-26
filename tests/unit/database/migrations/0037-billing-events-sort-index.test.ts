/**
 * @file Migration 0037 builds its new `billing_events` index before it
 * drops the old one. drizzle-kit writes the drop first, which would hold
 * the drop's ACCESS EXCLUSIVE lock (every read waits) through the whole
 * build; built first, the build holds only SHARE, and the drop's lock comes
 * at the end of the batch.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'

const MIGRATION = readFileSync(
  new URL(
    '../../../../src/database/migrations/0037_billing_events_sort_index.sql',
    import.meta.url
  ),
  'utf8'
)

describe('migration 0037', () => {
  it('creates the new index before it drops the old one, and drops last', () => {
    const create = MIGRATION.indexOf('CREATE INDEX "billing_events_tenant_received_sort_idx"')
    const drop = MIGRATION.indexOf('DROP INDEX "billing_events_tenant_received_idx"')

    expect(create).toBeGreaterThanOrEqual(0)
    expect(drop).toBeGreaterThan(create)
    expect(MIGRATION.slice(drop)).not.toMatch(/CREATE|ALTER/)
  })
})
