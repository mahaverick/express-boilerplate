/**
 * @file The `/api/v1/auth/passkeys` router. `GET /config` is public and
 * answers in every mode; every other passkey route runs
 * `requirePasskeysEnabled` first. A public read of fixed settings takes no
 * limiter: it has no oracle to probe.
 */
import { Router } from 'express'
import { passkeyController } from '@/controllers/passkey.controller'

/**
 * Build the passkey routes.
 * @returns A router mounted at `/api/v1/auth/passkeys` by `auth.routes.ts`.
 */
export function createPasskeyRouter(): Router {
  const router = Router()
  router.get('/config', passkeyController.getConfig)
  return router
}
