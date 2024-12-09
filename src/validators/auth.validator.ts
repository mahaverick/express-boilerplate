import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { userModel } from '@/database/models/user.model'
import db from '@/services/db.service'

/**
 * Login schema
 */
export const loginSchema = z.object({
  email: z
    .string()
    .email('Email is invalid')
    .refine(async (email) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.email, email),
      })
      return user !== null
    }, 'Email not found')
    .refine(async (email) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.email, email),
      })
      return user?.emailVerifiedAt !== null
    }, 'Email not verified'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  rememberMe: z.boolean().optional(),
})

export type LoginSchemaType = z.infer<typeof loginSchema>

/**
 * Register schema
 */
export const registerSchema = z.object({
  firstName: z.string().min(1, 'First name can not be empty'),
  middleName: z.string().min(1, 'Middle name can not be empty').optional(),
  lastName: z.string().min(1, 'Last name can not be empty'),
  username: z
    .string()
    .min(1, 'Username can not be empty')
    .refine(async (username) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.username, username),
      })
      return user === null || user?.username === undefined
    }, 'Username already in use'),
  email: z
    .string()
    .email('Email is invalid')
    .refine(async (email) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.email, email),
      })
      return user === null || user?.email === undefined
    }, 'Email already exists'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
})

export type RegisterSchemaType = z.infer<typeof registerSchema>

/**
 * Verify email schema token is a query parameter
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

export type VerifyEmailSchemaType = z.infer<typeof verifyEmailSchema>

/**
 * Resend verification email schema
 */
export const resendVerificationEmailSchema = z.object({
  email: z
    .string()
    .email('Email is invalid')
    .refine(async (email) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.email, email),
      })
      return user !== null
    }, 'Email does not exist'),
})

export type ResendVerificationEmailSchemaType = z.infer<typeof resendVerificationEmailSchema>

/**
 * Forget password schema
 */
export const forgetPasswordSchema = z.object({
  email: z
    .string()
    .email('Email is invalid')
    .refine(async (email) => {
      const user = await db.query.userModel.findFirst({
        where: eq(userModel.email, email),
      })
      return user !== null
    }, 'Email does not exist'),
})

export type ForgetPasswordSchemaType = z.infer<typeof forgetPasswordSchema>

/**
 * Verify reset token schema
 */
export const verifyResetTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

export type VerifyResetTokenSchemaType = z.infer<typeof verifyResetTokenSchema>

/**
 * Reset password schema
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters long'),
})

export type ResetPasswordSchemaType = z.infer<typeof resetPasswordSchema>
