/**
 * @file The auth providers that exist. The list is mirrored into a CHECK
 * constraint (auth-provider.model.ts): a new provider already needs a
 * strategy, env vars and a callback route, so a migration is a small part of it.
 */

/**
 * Every auth method the `auth_providers` table can record a row for.
 * `'email'` — a password-based account, `providerId` is the user's email
 * address. `'google'` — a federated Google Sign-In account, `providerId`
 * is Google's stable profile id.
 */
export const AUTH_PROVIDERS = ['email', 'google'] as const

/**
 * One of the fixed set of providers an `auth_providers` row may carry.
 */
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
