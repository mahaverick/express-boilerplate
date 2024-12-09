import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm'
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

import { userModel } from './user.model'

export enum TokenType {
  ACCESS_TOKEN = 'ACCESS_TOKEN',
  REFRESH_TOKEN = 'REFRESH_TOKEN',
  PASSWORD_RESET = 'PASSWORD_RESET',
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PHONE_VERIFICATION = 'PHONE_VERIFICATION',
}

export const TokenTypeEnum = pgEnum('token_type', [
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'PHONE_VERIFICATION',
])

/**
 * Tokens table
 */
export const tokenModel = pgTable('tokens', {
  id: serial('id').primaryKey().unique().notNull(),
  userId: integer('user_id')
    .references(() => userModel.id, { onDelete: 'cascade' })
    .notNull(),
  type: TokenTypeEnum('type').notNull(),
  value: text('value').notNull(),
  sessionId: varchar('session_id', { length: 255 }),
  provider: varchar('provider', { length: 255 }).default('boilerplate').notNull(),

  // Token status fields
  active: boolean('active').default(false).notNull(),

  // Timestamps
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).defaultNow(),
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

export const tokenRelations = relations(tokenModel, ({ one }) => ({
  user: one(userModel, {
    fields: [tokenModel.userId],
    references: [userModel.id],
  }),
}))

export type Token = InferSelectModel<typeof tokenModel>
export type InsertToken = InferInsertModel<typeof tokenModel>
