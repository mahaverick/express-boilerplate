import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { organizationModel } from './organization.model';

export const instituteModel = pgTable(
  'institutes',
  {
    id: serial('id').primaryKey().unique().notNull(),

    // Organization relationship
    organizationId: integer('organization_id')
      .references(() => organizationModel.id, { onDelete: 'cascade' })
      .notNull(),

    // Unique identifier field
    identifier: varchar('identifier', { length: 100 }).notNull().unique(),

    // Institute fields
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    logo: varchar('logo', { length: 255 }),
    website: varchar('website', { length: 100 }),
    division: varchar('division', { length: 255 }), //JEE, NEET, etc
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 32 }),
    fax: varchar('fax', { length: 32 }),
    address: text('address'),
    city: varchar('city', { length: 120 }),
    state: varchar('state', { length: 120 }),
    country: varchar('country', { length: 120 }),
    pincode: varchar('pincode', { length: 10 }),
    latitude: varchar('latitude', { length: 32 }),
    longitude: varchar('longitude', { length: 32 }),

    // Institute status fields
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
      instituteIdentifierIndex: uniqueIndex('institute_identifier_index').on(table.identifier),
    };
  },
);

export const instituteRelations = relations(instituteModel, ({ one }) => ({
  organization: one(organizationModel, {
    fields: [instituteModel.organizationId],
    references: [organizationModel.id],
  }),
}));

export type Institute = InferSelectModel<typeof instituteModel>;
export type InsertInstitute = InferInsertModel<typeof instituteModel>;
