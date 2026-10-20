/**
 * @file The `/api/v1/auth/passkeys` router. `GET /config` is public and
 * answers in every mode; every other passkey route runs
 * `requirePasskeysEnabled` first, then `requireAuth`, except the two public
 * sign-in routes. Creating and deleting a
 * passkey also needs a recent sign-in. A public read of fixed settings takes no
 * limiter: it has no oracle to probe.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { passkeyController } from '@/controllers/passkey.controller'
import { requireAuth, requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireAllowedOriginWhenPresent } from '@/middlewares/origin.middleware'
import { requirePasskeysEnabled } from '@/middlewares/passkey.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the passkey routes.
 * @returns A router mounted at `/api/v1/auth/passkeys` by `auth.routes.ts`.
 */
export function createPasskeyRouter(): Router {
  const router = Router()
  router.get('/config', passkeyController.getConfig)
  // Everything below is hidden in `off` mode: the gate runs before any auth or limiter.
  router.use(requirePasskeysEnabled)
  // One instance on every write, so one budget covers create, rename and delete; requireAuth first, as it keys on request.user.id.
  const manageLimiter = createRateLimiter(RATE_LIMITS.passkeyManage)
  // Public: sign-in has no session. The Origin check runs before the limiter, as on /auth/link/verify, so a refused page spends no budget; one instance covers options and verify.
  const signInLimiter = createRateLimiter(RATE_LIMITS.passkeySignIn)
  router.post(
    '/sign-in/options',
    requireAllowedOriginWhenPresent,
    signInLimiter,
    passkeyController.signInOptions
  )
  router.post(
    '/sign-in/verify',
    requireAllowedOriginWhenPresent,
    signInLimiter,
    passkeyController.signInVerify
  )
  // A read of the caller's own list: no oracle to probe, so no limiter.
  router.get('/', requireAuth, passkeyController.list)
  router.post(
    '/registration/options',
    requireAuth,
    manageLimiter,
    requireRecentAuth(),
    passkeyController.registrationOptions
  )
  router.post(
    '/registration/verify',
    requireAuth,
    manageLimiter,
    requireRecentAuth(),
    passkeyController.registrationVerify
  )
  router.patch('/:id', requireAuth, manageLimiter, passkeyController.rename)
  router.delete('/:id', requireAuth, manageLimiter, requireRecentAuth(), passkeyController.remove)
  return router
}
