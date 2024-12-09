import { Router } from 'express'

import { AuthController } from '@/controllers/auth.controller'
import { requireAuthentication } from '@/middlewares/auth.middleware'
import { zodValidate } from '@/middlewares/validation.middleware'
import {
  forgetPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationEmailSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  verifyResetTokenSchema,
} from '@/validators/auth.validator'

const router = Router()
const authController = new AuthController()

// with validation
router.post('/register', zodValidate(registerSchema), authController.register)
router.post('/login', zodValidate(loginSchema), authController.login)

router.post('/email/verify', zodValidate(verifyEmailSchema), authController.verifyEmail)
router.post(
  '/email/resend-verification',
  zodValidate(resendVerificationEmailSchema),
  authController.resendVerificationEmail
)

router.post('/password/forgot', zodValidate(forgetPasswordSchema), authController.forgotPassword)
router.post(
  '/password/verify-reset-token',
  zodValidate(verifyResetTokenSchema),
  authController.verifyPasswordResetToken
)
router.post('/password/reset', zodValidate(resetPasswordSchema), authController.resetPassword)

// without validation
router.post('/refresh', authController.refresh)

// require authentication
router.post('/logout', requireAuthentication, authController.logout)

export default router
