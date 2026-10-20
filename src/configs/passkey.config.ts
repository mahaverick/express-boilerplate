/**
 * @file The WebAuthn relying party: who the passkeys belong to and which
 * browser origins may use them. Both take the env as an argument so tests pass
 * a crafted one; the default is the validated `getEnv()`.
 */
import { getEnv, type Env } from '@/configs/env.config'

/**
 * The relying party a passkey is bound to.
 */
export interface PasskeyRelyingParty {
  /**
  The RP ID: `WEBAUTHN_RP_ID`, else the host of `WEB_URL`.
   */
  rpId: string
  /**
  The name an authenticator shows, `APP_NAME`.
   */
  rpName: string
  /**
  The browser origins that may present a passkey: `WEB_URL`, plus `APEX_URL` when set.
   */
  origins: string[]
}

/**
 * The relying party for passkey registration and sign-in. `CORS_ALLOWED_ORIGINS`
 * extras are not passkey origins.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns The RP ID, RP name and expected origins.
 */
export function passkeyRelyingParty(
  env: Pick<Env, 'WEB_URL' | 'APEX_URL' | 'WEBAUTHN_RP_ID' | 'APP_NAME'> = getEnv()
): PasskeyRelyingParty {
  const web = new URL(env.WEB_URL)
  const origins = [web.origin]
  if (env.APEX_URL !== undefined) origins.push(new URL(env.APEX_URL).origin)
  return { rpId: env.WEBAUTHN_RP_ID ?? web.hostname, rpName: env.APP_NAME, origins }
}

/**
 * Whether passkey routes answer, that is, the mode is not `off`.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns True for `optional` and `required`.
 */
export function isPasskeyEnabled(env: Pick<Env, 'PASSKEY_MODE'> = getEnv()): boolean {
  return env.PASSKEY_MODE !== 'off'
}
