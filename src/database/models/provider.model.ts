import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm'
import { boolean, integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core'

import { userModel } from './user.model'

/**
 * Providers table
 */
export const providerModel = pgTable('providers', {
  id: serial('id').primaryKey().unique().notNull(),

  // User relationship
  userId: integer('user_id')
    .references(() => userModel.id, { onDelete: 'cascade' })
    .notNull(),
  type: varchar('type', { length: 255 }).notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),

  // Provider status fields
  active: boolean('active').default(false).notNull(),

  // Timestamps
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'date',
  })
    .defaultNow()
    .notNull(),
})

export const providerRelations = relations(providerModel, ({ one }) => ({
  user: one(userModel, {
    fields: [providerModel.userId],
    references: [userModel.id],
  }),
}))

export type Provider = InferSelectModel<typeof providerModel>
export type InsertProvider = InferInsertModel<typeof providerModel>
