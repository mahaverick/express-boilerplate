/**
 * @file The passkey controller: handlers for `/api/v1/auth/passkeys`.
 */
import type { Request } from 'express'
import { getEnv } from '@/configs/env.config'
import { passkeyRelyingParty } from '@/configs/passkey.config'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { toPublicPasskey } from '@/presenters/passkey.presenter'
import type { AuthenticatedUser } from '@/presenters/user.presenter'
import {
  deletePasskey,
  finishPasskeyRegistration,
  listPasskeys,
  renamePasskey,
  startPasskeyRegistration,
} from '@/services/passkey.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  passkeyDeleteQuerySchema,
  passkeyRegistrationOptionsSchema,
  passkeyRegistrationVerifySchema,
  passkeyRenameSchema,
} from '@/validators/passkey.validators'

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

  /**
   * `GET /auth/passkeys`: the caller's passkeys, as `{ passkeys }`.
   */
  list = this.handle(async (request, response) => {
    const rows = await listPasskeys(authenticatedUserId(request))
    successResponse(
      response,
      { passkeys: rows.map((row) => toPublicPasskey(row)) },
      'Passkeys retrieved.'
    )
  })

  /**
   * `POST /auth/passkeys/registration/options`: a challenge and the WebAuthn
   * creation options, as `{ challengeId, options }`.
   */
  registrationOptions = this.handle(async (request, response) => {
    parseBody(passkeyRegistrationOptionsSchema, request.body)
    const user = requireUser(request)
    const started = await startPasskeyRegistration(user)
    successResponse(response, started, 'Passkey options created.')
  })

  /**
   * `POST /auth/passkeys/registration/verify`: verify the browser's response
   * and store the passkey, as 201 `{ passkey }`.
   */
  registrationVerify = this.handle(async (request, response) => {
    const input = parseBody(passkeyRegistrationVerifySchema, request.body)
    const created = await finishPasskeyRegistration(requireUser(request), input)
    successResponse(response, { passkey: toPublicPasskey(created) }, 'Passkey created.', 201)
  })

  /**
   * `PATCH /auth/passkeys/:id`: rename a passkey, as `{ passkey }`.
   */
  rename = this.handle(async (request, response) => {
    const input = parseBody(passkeyRenameSchema, request.body)
    const row = await renamePasskey(
      authenticatedUserId(request),
      String(request.params.id),
      input.name
    )
    successResponse(response, { passkey: toPublicPasskey(row) }, 'Passkey renamed.')
  })

  /**
   * `DELETE /auth/passkeys/:id`: delete a passkey and answer the passkeys that
   * remain, as `{ passkeys }`, which the app hands to the browser.
   */
  remove = this.handle(async (request, response) => {
    const { app } = parseBody(passkeyDeleteQuerySchema, request.query)
    const remaining = await deletePasskey(requireUser(request), String(request.params.id), app)
    successResponse(
      response,
      { passkeys: remaining.map((row) => toPublicPasskey(row)) },
      'Passkey deleted.'
    )
  })
}

/**
 * The signed-in user, guarding against a route reaching a handler without `requireAuth`.
 * @param request - The incoming request.
 * @returns The authenticated user.
 * @throws {HttpError} 401 when `request.user` was never set.
 */
function requireUser(request: Request): AuthenticatedUser {
  if (!request.user) throw new HttpError('Sign in to continue.', 401)
  return request.user
}

/**
 * The instance whose handlers `createPasskeyRouter` mounts.
 */
export const passkeyController = new PasskeyController()
