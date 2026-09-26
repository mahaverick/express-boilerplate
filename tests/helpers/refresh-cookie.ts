// tests/helpers/refresh-cookie.ts
//
// The refresh cookie's name and path under the suite's own environment
// (APP_ENV=local, COOKIE_SECURE and COOKIE_DOMAIN unset): refreshToken on
// /api/v1/auth. Tests that set their own cookie env build names themselves.
import { getEnv, isCookieSecure } from '@/configs/env.config'
import { refreshCookieSpec, type RefreshCookieSpec } from '@/constants/auth.constants'

/**
 * The refresh cookie's spec for the environment getEnv() returns now.
 * @returns Its name, path and domain.
 */
export function testRefreshCookie(): RefreshCookieSpec {
  const env = getEnv()
  return refreshCookieSpec({ COOKIE_SECURE: isCookieSecure(env), COOKIE_DOMAIN: env.COOKIE_DOMAIN })
}
