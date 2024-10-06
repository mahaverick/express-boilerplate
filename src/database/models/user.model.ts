import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';
import {
  boolean,
  date,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { organizationModel } from '@/database/models/organization.model';
import { providerModel } from '@/database/models/provider.model';

export const userRole = pgEnum('user_role', ['superAdmin', 'admin', 'teacher', 'user', 'guest']);

export const userModel = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),

    // Unique identifier field
    username: varchar('username', { length: 255 }).notNull().unique(),

    // User fields
    firstName: varchar('first_name', { length: 255 }).notNull(),
    middleName: varchar('middle_name', { length: 255 }),
    lastName: varchar('last_name', { length: 255 }),
    email: varchar('email', { length: 255 }).notNull().unique(),
    password: varchar('password', { length: 255 }),
    role: userRole('role').default('user').notNull(),
    phone: varchar('phone', { length: 32 }),
    avatar: varchar('avatar', { length: 255 }),
    dateOfBirth: date('date_of_birth'),
    gender: varchar('gender', { length: 32 }),

    // User status fields
    active: boolean('active').default(false).notNull(),

    // Timestamps
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    phoneVerifiedAt: timestamp('phone_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastLoggedInAt: timestamp('last_logged_in_at', {
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
      emailIndex: uniqueIndex('email_index').on(table.email),
      usernameIndex: uniqueIndex('username_index').on(table.username),
    };
  },
);

export const userRelations = relations(userModel, ({ many }) => ({
  providers: many(providerModel),
  organizations: many(organizationModel),
}));

export type User = InferSelectModel<typeof userModel>;
export type InsertUser = InferInsertModel<typeof userModel>;
