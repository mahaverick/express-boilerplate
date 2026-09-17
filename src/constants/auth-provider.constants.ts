// src/constants/auth-provider.constants.ts
//
// The single source of truth for which auth providers exist — same
// "one array, one place" pattern as TOKEN_PURPOSES (user-token.model.ts)
// and EMAIL_LOG_STATUSES (email-log.model.ts). Unlike NOTIFICATION_TYPES
// (notification.constants.ts), which is deliberately left unconstrained at
// the database because that list is meant to grow freely, this one IS
// mirrored into a database CHECK constraint (auth-provider.model.ts):
// adding a provider is never just a new string — it means a new Passport
// strategy, new env vars, and a new callback route, so the migration a
// CHECK constraint would need is the smallest part of that change, not an
// added cost worth avoiding.

/**
 * Every auth method the `auth_providers` table can record a row for.
 * `'email'` — a password-based account, `providerId` is the user's email
 * address. `'google'` — a federated Google Sign-In account, `providerId`
 * is Google's stable profile id.
 */
export const AUTH_PROVIDERS = ['email', 'google'] as const

/**
 * One of the fixed set of providers an `auth_providers` row may carry.
 * Derived from `AUTH_PROVIDERS` so this type can never list a value the
 * runtime array — and therefore the database CHECK constraint built from
 * it — does not also recognise.
 */
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
