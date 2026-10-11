/**
 * @file The auth providers that exist. The list is mirrored into a CHECK
 * constraint (auth-provider.model.ts), but adding a provider also needs a
 * strategy, env vars and a callback route, so the migration is the small part.
 */

/**
 * Every auth method the `auth_providers` table can record a row for.
 * For `'email'`, `providerId` is the user's email address; Google sign-ups
 * get this row too, without a password. For `'google'`, it is Google's
 * stable profile id.
 */
export const AUTH_PROVIDERS = ['email', 'google'] as const

/**
 * One of the providers in `AUTH_PROVIDERS`, the only values an
 * `auth_providers` row may carry.
 */
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
