// src/controllers/user.controller.ts

import crypto from 'crypto'

import { Request, Response } from 'express'
import asyncHandler from 'express-async-handler'

import { REFRESH_TOKEN, SESSION_TOKEN } from '@/configs/constants/constants'
import { BaseController } from '@/controllers/base.controller'
import { TokenType } from '@/database/models/token.model'
import { TokenRepository } from '@/repositories/token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { mailer } from '@/services/mailer.service'
import {
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyToken,
} from '@/utils/auth.utils'
import { logger } from '@/utils/logger.utils'
import { LoginSchemaType, RegisterSchemaType } from '@/validators/auth.validator'

export class AuthController extends BaseController {
  /**
   * UserRepository
   * @type {UserRepository}
   */
  private userRepo: UserRepository

  /**
   * TokenRepository
   * @type {TokenRepository}
   */
  private tokenRepo: TokenRepository

  /**
   * Constructor  - Initialize UserController
   */
  constructor() {
    super()
    this.userRepo = new UserRepository()
    this.tokenRepo = new TokenRepository()
  }

  /**
   * Login existing user, by providing email and password
   *
   * @param {Request} req - Request object
   * @param {string} req.email - Email used by the account
   * @param {string} req.password - Password for the account
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  login = asyncHandler(async (req: Request<any, any, LoginSchemaType>, res: Response) => {
    try {
      const { email, password, rememberMe } = req.body
      const user = await this.userRepo.findByEmailWithSensitiveColumns(email)

      if (!user) {
        return this.sendError(res, 'Wrong credentials!!', 401, 'WRONG_CREDENTIALS')
      }

      if (!user.password) {
        return this.sendError(
          res,
          `You usually login with ${user.providers[0]?.type} provider`,
          400,
          'INVALID_LOGIN_METHOD'
        )
      }

      const isPasswordMatch = await comparePassword(password, user.password)

      if (!isPasswordMatch) {
        return this.sendError(res, 'Wrong credentials!!', 401, 'WRONG_CREDENTIALS')
      }

      const sessionId = crypto.randomBytes(12).toString('hex')

      const accessToken = generateAccessToken(user.id, user.email, sessionId)
      const refreshToken = await generateRefreshToken(user.id, sessionId, rememberMe)

      // SET refresh Token cookie in response
      res.cookie(REFRESH_TOKEN.cookie.name, refreshToken, REFRESH_TOKEN.cookie.options)
      res.cookie(SESSION_TOKEN.cookie.name, sessionId, SESSION_TOKEN.cookie.options)

      //sanitize user object
      const sanitizedUser = this.userRepo.sanitize(user)

      return this.sendResponse(res, { accessToken, user: sanitizedUser }, 200, 'Login successful')
    } catch (e) {
      const error = e as Error

      logger.error('Error logging in user: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'LOGIN_ERROR')
    }
  })

  /**
   * Register new user
   *
   * @param {Request} req - Request object
   * @param {string} req.firstName - First name of the user for the account
   * @param {string} req.lastName - Last name of the user for the account
   * @param {string} req.username - Username of the user for the account
   * @param {string} req.email - Email used by the account
   * @param {string} req.password -Password for the account logging in
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  register = asyncHandler(async (req: Request<any, any, RegisterSchemaType>, res: Response) => {
    try {
      const { username, email, password, firstName, lastName, middleName } = req.body

      const { tokenValue } = await this.userRepo.create({
        username,
        email,
        password,
        firstName,
        middleName,
        lastName,
      })

      if (tokenValue) {
        // Send verification email
        await mailer.sendVerificationEmail(email, tokenValue)
      }

      return this.sendResponse(res, null, 201, 'User registered successfully')
    } catch (e) {
      const error = e as Error

      logger.error('Error registering user: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'REGISTER_ERROR')
    }
  })

  /**
   * Refresh access token
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  refresh = asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.cookies[SESSION_TOKEN.cookie.name]
    const refreshToken = req.cookies[REFRESH_TOKEN.cookie.name]

    if (!refreshToken) {
      res.setHeader('X-Refresh-Token-Missing', 'true')
      return this.sendError(res, 'Refresh token not found', 401, 'REFRESH_TOKEN_MISSING')
    }

    try {
      const decoded = verifyToken(refreshToken)

      if (!decoded || decoded.sessionId !== sessionId) {
        res.setHeader('X-Refresh-Token-Invalid', 'true')
        return this.sendError(res, 'Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN')
      }

      // Create a hash of the refresh token
      const rTknHash = hashRefreshToken(refreshToken)

      const token = await this.tokenRepo.findByValueAndType(rTknHash, TokenType.REFRESH_TOKEN)

      if (!token || token.sessionId !== sessionId) {
        return this.sendError(res, 'Invalid session', 401, 'INVALID_SESSION')
      }

      if (!token.user) {
        return this.sendError(res, 'User not found', 404, 'USER_NOT_FOUND')
      }

      //sanitize user object
      const sanitizedUser = this.userRepo.sanitize(token.user)

      const accessToken = generateAccessToken(token.userId, token.user.email, sessionId)

      return this.sendResponse(
        res,
        { accessToken, user: sanitizedUser },
        200,
        'Access token refreshed'
      )
    } catch (e) {
      const error = e as Error
      logger.error('Error verifying refresh token: [auth.controller] - ', error)

      if (error.message === 'jwt expired') {
        return this.sendError(
          res,
          'Refresh token expired. Please login again.',
          401,
          'REFRESH_TOKEN_EXPIRED'
        )
      }

      if (error.message === 'jwt malformed' || error.message === 'invalid token') {
        return this.sendError(
          res,
          'Invalid token. Please provide a valid token.',
          401,
          'REFRESH_TOKEN_INVALID'
        )
      }

      return this.sendError(res, error.message, 500, 'REFRESH_TOKEN_ERROR')
    }
  })

  /**
   * Logout user
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  logout = asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.sessionId
    try {
      res.clearCookie(REFRESH_TOKEN.cookie.name)
      res.clearCookie(SESSION_TOKEN.cookie.name)

      await this.tokenRepo.deleteBySessionId(sessionId)

      return this.sendResponse(res, null, 200, 'Logout successful')
    } catch (e) {
      const error = e as Error

      logger.error('Error logging out user: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'LOGOUT_ERROR')
    }
  })

  /**
   * Verify email
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  verifyEmail = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body

    if (!token || typeof token !== 'string') {
      return this.sendError(res, 'Invalid verification token', 400, 'INVALID_TOKEN')
    }

    try {
      const verificationToken = await this.tokenRepo.findByValueAndType(
        token,
        TokenType.EMAIL_VERIFICATION
      )

      if (!verificationToken || !verificationToken.active) {
        return this.sendError(res, 'Invalid or expired verification token', 400, 'INVALID_TOKEN')
      }

      const user = await this.userRepo.findByIdWithSensitiveColumns(verificationToken.userId)

      if (!user) {
        return this.sendError(res, 'User not found', 404, 'USER_NOT_FOUND')
      }

      if (user.emailVerifiedAt) {
        return this.sendError(res, 'Email already verified', 400, 'ALREADY_VERIFIED')
      }

      await this.userRepo.verifyEmail(user.id)
      await this.tokenRepo.deactivateToken(verificationToken.id)

      return this.sendResponse(res, null, 200, 'Email verified successfully')
    } catch (e) {
      const error = e as Error
      logger.error('Error verifying email: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'EMAIL_VERIFICATION_ERROR')
    }
  })

  /**
   * Resend verification email
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  resendVerificationEmail = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body

    if (!email) {
      return this.sendError(res, 'Email is required', 400, 'EMAIL_REQUIRED')
    }

    try {
      const user = await this.userRepo.findByEmailWithSensitiveColumns(email)

      if (!user) {
        return this.sendError(res, 'User not found', 404, 'USER_NOT_FOUND')
      }

      if (user.emailVerifiedAt) {
        return this.sendError(res, 'Email already verified', 400, 'ALREADY_VERIFIED')
      }

      // Generate new verification token
      const token = await this.tokenRepo.createEmailVerificationToken(user.id)

      if (token.value) {
        await mailer.sendVerificationEmail(email, token.value)
      }

      return this.sendResponse(res, null, 200, 'Verification email sent successfully')
    } catch (e) {
      const error = e as Error
      logger.error('Error resending verification email: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'EMAIL_RESEND_ERROR')
    }
  })

  /**
   * Initiate forgot password process
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body

    try {
      const user = await this.userRepo.findByEmailWithSensitiveColumns(email)

      if (user) {
        // Generate password reset token
        const token = await this.tokenRepo.createPasswordResetToken(user.id)

        if (token.value) {
          await mailer.sendPasswordResetEmail(email, token.value)
        }
      }

      // Always return a success message, even if the email doesn't exist
      return this.sendResponse(
        res,
        null,
        200,
        'If the email exists, a password reset link has been sent.'
      )
    } catch (e) {
      const error = e as Error
      logger.error('Error initiating forgot password: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'FORGOT_PASSWORD_ERROR')
    }
  })

  /**
   * Verify password reset token
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  verifyPasswordResetToken = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body

    if (!token) {
      return this.sendError(res, 'Token is required', 400, 'TOKEN_REQUIRED')
    }

    try {
      const resetToken = await this.tokenRepo.findByValueAndType(token, TokenType.PASSWORD_RESET)

      if (!resetToken || !resetToken.active) {
        return this.sendError(res, 'Invalid or expired reset token', 400, 'INVALID_TOKEN')
      }

      return this.sendResponse(res, null, 200, 'Valid reset token')
    } catch (e) {
      const error = e as Error
      logger.error('Error verifying password reset token: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'VERIFY_RESET_TOKEN_ERROR')
    }
  })

  /**
   * Reset password
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @memberof AuthController
   */
  resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword } = req.body

    if (!token || !newPassword) {
      return this.sendError(res, 'Token and new password are required', 400, 'MISSING_FIELDS')
    }

    try {
      const resetToken = await this.tokenRepo.findByValueAndType(token, TokenType.PASSWORD_RESET)

      if (!resetToken || !resetToken.active) {
        return this.sendError(res, 'Invalid or expired reset token', 400, 'INVALID_TOKEN')
      }

      const user = await this.userRepo.findByIdWithSensitiveColumns(resetToken.userId)

      if (!user) {
        return this.sendError(res, 'User not found', 404, 'USER_NOT_FOUND')
      }

      // Update user's password
      await this.userRepo.updatePassword(user.id, newPassword)

      // Deactivate the reset token
      await this.tokenRepo.deactivateToken(resetToken.id)

      return this.sendResponse(res, null, 200, 'Password reset successfully')
    } catch (e) {
      const error = e as Error
      logger.error('Error resetting password: [auth.controller] - ', error)
      return this.sendError(res, error.message, 500, 'RESET_PASSWORD_ERROR')
    }
  })
}
