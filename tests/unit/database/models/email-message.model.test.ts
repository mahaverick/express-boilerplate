/**
 * @file Column widths email_messages shares with email_logs, read from the
 * Drizzle table definitions, so the two cannot drift.
 */
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { emailLogModel, TEMPLATE_KEY_MAX_LENGTH } from '@/database/models/email-log.model'
import {
  emailMessageModel,
  MESSAGE_TEMPLATE_KEY_MAX_LENGTH,
} from '@/database/models/email-message.model'

/**
 * The declared width of one varchar column.
 * @param table - The Drizzle table.
 * @param name - The column's SQL name.
 * @returns Its `length`, or undefined.
 */
function widthOf(table: Parameters<typeof getTableConfig>[0], name: string): number | undefined {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === name)
  return (column as { length?: number } | undefined)?.length
}

describe('email_messages', () => {
  it('stores template_key at the width email_logs does', () => {
    expect(MESSAGE_TEMPLATE_KEY_MAX_LENGTH).toBe(TEMPLATE_KEY_MAX_LENGTH)
    expect(widthOf(emailMessageModel, 'template_key')).toBe(widthOf(emailLogModel, 'template_key'))
  })
})
