import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm'
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

import { instituteModel } from './institute.model'
import { userModel } from './user.model'

export const organizationModel = pgTable(
  'organizations',
  {
    id: serial('id').primaryKey().unique().notNull(),

    // User relationship
    userId: integer('user_id')
      .references(() => userModel.id, { onDelete: 'cascade' })
      .notNull(),

    // Unique identifier field
    identifier: varchar('identifier', { length: 100 }).notNull().unique(),

    // Organization fields
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    logo: varchar('logo', { length: 255 }),
    website: varchar('website', { length: 100 }),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 32 }),
    fax: varchar('fax', { length: 32 }),
    address: text('address'),
    city: varchar('city', { length: 120 }),
    state: varchar('state', { length: 120 }),
    country: varchar('country', { length: 120 }),
    pincode: varchar('pincode', { length: 10 }),
    latitude: varchar('latitude', { length: 40 }),
    longitude: varchar('longitude', { length: 40 }),

    // Business identification fields
    pan: varchar('pan', { length: 30 }),
    tan: varchar('tan', { length: 30 }),
    cin: varchar('cin', { length: 30 }),
    gstin: varchar('gstin', { length: 30 }),
    udyamRegistrationNumber: varchar('udyam_registration_number', { length: 30 }),

    // Organization status fields
    active: boolean('active').default(false).notNull(),

    // Timestamps
    establishedAt: timestamp('established_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletedAt: timestamp('deleted_at', {
      withTimezone: true,
      mode: 'date',
    }),
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
  },
  (table) => {
    return {
      orgIdentifierIndex: uniqueIndex('org_identifier_index').on(table.identifier),
    }
  }
)

export const organizationRelations = relations(organizationModel, ({ one, many }) => ({
  user: one(userModel, {
    fields: [organizationModel.userId],
    references: [userModel.id],
  }),
  institutes: many(instituteModel),
}))

export type Organization = InferSelectModel<typeof organizationModel>
export type InsertOrganization = InferInsertModel<typeof organizationModel>
