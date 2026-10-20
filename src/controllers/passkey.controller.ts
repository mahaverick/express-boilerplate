/**
 * @file The passkey controller: handlers for `/api/v1/auth/passkeys`.
 */
import { getEnv } from '@/configs/env.config'
import { passkeyRelyingParty } from '@/configs/passkey.config'
import { BaseController } from '@/controllers/base.controller'
import { successResponse } from '@/utilities/response.utilities'

/**
 * Handlers for the passkey routes.
 */
class PasskeyController extends BaseController {
  /**
   * `GET /auth/passkeys/config`: the mode and RP ID, as `{ mode, rpId }`.
   * Public and uncached, and it answers in `off` too, so the apps can hide
   * their passkey UI.
   */
  getConfig = this.handle((_request, response) => {
    const env = getEnv()
    response.set('Cache-Control', 'no-store')
    successResponse(
      response,
      { mode: env.PASSKEY_MODE, rpId: passkeyRelyingParty(env).rpId },
      'Passkey settings retrieved.'
    )
  })
}

/**
 * The instance whose handlers `createPasskeyRouter` mounts.
 */
export const passkeyController = new PasskeyController()
