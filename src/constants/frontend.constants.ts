/**
 * @file The frontends this API sends people to: the customer app (`WEB_URL`)
 * and the Apex staff dashboard (`APEX_URL`).
 */

/**
 * Every frontend a link or redirect can target. A request may name one of
 * these, never a URL.
 */
export const FRONTEND_APPS = ['web', 'apex'] as const

/**
 * One of FRONTEND_APPS.
 */
export type FrontendApp = (typeof FRONTEND_APPS)[number]

/**
 * Whether a value is one of FRONTEND_APPS.
 * @param value - Anything read from a query string or a session.
 * @returns True for 'web' or 'apex' exactly.
 */
export function isFrontendApp(value: unknown): value is FrontendApp {
  return typeof value === 'string' && (FRONTEND_APPS as readonly string[]).includes(value)
}
