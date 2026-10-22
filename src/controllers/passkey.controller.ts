/**
 * @file The passkey controller: handlers for `/api/v1/auth/passkeys`.
 */
import type { Request } from 'express'
import { getEnv } from '@/configs/env.config'
import { passkeyRelyingParty } from '@/configs/passkey.config'
import { BaseController } from '@/controllers/base.controller'
import {
  authenticatedUserId,
  revokePresentedSession,
  setRefreshTokenCookie,
} from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { toPublicPasskey } from '@/presenters/passkey.presenter'
import { toProfileResponse, type AuthenticatedUser } from '@/presenters/user.presenter'
import {
  deletePasskey,
  finishPasskeyRegistration,
  finishPasskeySignIn,
  listPasskeys,
  passkeyUserHandle,
  renamePasskey,
  startPasskeyRegistration,
  startPasskeySignIn,
} from '@/services/passkey.service'
import { finishPasskeyStepUp, startPasskeyStepUp } from '@/services/step-up.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  passkeyDeleteQuerySchema,
  passkeyRegistrationOptionsSchema,
  passkeyRegistrationVerifySchema,
  passkeyRenameSchema,
  passkeySignInOptionsSchema,
  passkeySignInVerifySchema,
  passkeyStepUpOptionsSchema,
  passkeyStepUpVerifySchema,
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
   * `GET /auth/passkeys`: the caller's passkeys, as `{ userHandle, passkeys }`.
   */
  list = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const rows = await listPasskeys(userId)
    successResponse(
      response,
      { userHandle: passkeyUserHandle(userId), passkeys: rows.map((row) => toPublicPasskey(row)) },
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
   * `POST /auth/passkeys/sign-in/options`: a challenge and the WebAuthn request
   * options with no named credential, as `{ challengeId, options }`. Public.
   */
  signInOptions = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    parseBody(passkeySignInOptionsSchema, request.body)
    successResponse(response, await startPasskeySignIn(), 'Passkey options created.')
  })

  /**
   * `POST /auth/passkeys/sign-in/verify`: verify the browser's assertion and
   * sign in, answering exactly what `/auth/link/verify` does. A refresh cookie
   * the browser still presented has its session revoked once the new one is
   * issued. `no-store`, as every token response (RFC 6749 §5.1).
   */
  signInVerify = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(passkeySignInVerifySchema, request.body)
    const session = await finishPasskeySignIn(input)
    await revokePresentedSession(request, { emitSignedOut: false })
    setRefreshTokenCookie(
      request,
      response,
      session.refreshToken.raw,
      session.refreshToken.expiresAt
    )
    successResponse(
      response,
      {
        user: toProfileResponse(session.user, session.platformRole),
        accessToken: session.accessToken,
        redirect: null,
        isNewUser: false,
      },
      'Signed in.'
    )
  })

  /**
   * `POST /auth/passkeys/step-up/options`: a challenge bound to the caller's
   * session and the WebAuthn request options naming the caller's passkeys, as
   * `{ challengeId, options }`. 409 `NO_PASSKEY` when the caller has none.
   */
  stepUpOptions = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    parseBody(passkeyStepUpOptionsSchema, request.body)
    const started = await startPasskeyStepUp(authenticatedUserId(request), request.sessionId)
    successResponse(response, started, 'Passkey options created.')
  })

  /**
   * `POST /auth/passkeys/step-up/verify`: verify the assertion and reply with
   * a new access token carrying the new `auth_time`, as the link step-up does.
   * The refresh cookie is untouched: the session is the same. `no-store`, as
   * every token response (RFC 6749 §5.1).
   */
  stepUpVerify = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(passkeyStepUpVerifySchema, request.body)
    const result = await finishPasskeyStepUp(authenticatedUserId(request), request.sessionId, input)
    successResponse(response, { accessToken: result.accessToken }, 'Identity confirmed.')
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
   * remain, as `{ userHandle, passkeys }`, which the app hands to the browser.
   */
  remove = this.handle(async (request, response) => {
    const { app } = parseBody(passkeyDeleteQuerySchema, request.query)
    const user = requireUser(request)
    const remaining = await deletePasskey(user, String(request.params.id), app)
    successResponse(
      response,
      {
        userHandle: passkeyUserHandle(user.id),
        passkeys: remaining.map((row) => toPublicPasskey(row)),
      },
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
