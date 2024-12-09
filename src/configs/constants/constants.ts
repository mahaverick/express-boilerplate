import { config } from 'dotenv'
import { CookieOptions } from 'express'
import ms from 'ms'

config()

/**
 * Environment
 *
 * @export
 * @constant {string} ENV
 */
export const ENV = process.env.NODE_ENV || 'development'

/**
 * Database URL
 *
 * @export
 * @constant {string} DATABASE_URL
 */
export const DATABASE_URL = process.env.DATABASE_URL as string

/**
 * Access token
 *
 * @export
 * @constant {object} ACCESS_TOKEN
 */
export const ACCESS_TOKEN = {
  expiry: process.env.ACCESS_TOKEN_EXPIRY as string,
}

/**
 * Refresh token
 *
 * @export
 * @constant {object} REFRESH_TOKEN
 */
export const REFRESH_TOKEN = {
  expiry: process.env.REFRESH_TOKEN_EXPIRY as string,
  cookie: {
    name: 'refTkn',
    options: {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: ms(process.env.REFRESH_TOKEN_EXPIRY as string),
    } as CookieOptions,
  },
}

/**
 * Session token
 *
 * @export
 * @constant {object} SESSION_TOKEN
 */
export const SESSION_TOKEN = {
  cookie: {
    name: 'sid',
    options: {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: ms(process.env.REFRESH_TOKEN_EXPIRY as string),
    } as CookieOptions,
  },
}

/**
 * Private key
 *
 * @export
 * @constant {string} PRIVATE_KEY
 */
export const PRIVATE_KEY = process.env.TOKEN_PRIVATE_KEY as string

/**
 * Public key
 *
 * @export
 * @constant {string} PUBLIC_KEY
 */
export const PUBLIC_KEY = process.env.TOKEN_PUBLIC_KEY as string

/**
 * SMTP credentials
 *
 * @export
 * @constant {object} SMTP_CREDENTIALS
 */
export const SMTP_CREDENTIALS = {
  host: process.env.SMTP_HOST as string,
  port: Number(process.env.SMTP_PORT),
  secure: Boolean(process.env.SMTP_SECURE) || false,
  username: process.env.SMTP_USERNAME as string,
  password: process.env.SMTP_PASSWORD as string,
}

/**
 * Client URL
 *
 * @export
 * @constant {string} CLIENT_URL
 */
export const CLIENT_URL = process.env.CLIENT_URL as string

/**
 * AWS region
 *
 * @export
 * @constant {string} AWS_REGION
 */
export const AWS = {
  region: process.env.AWS_REGION as string,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
}

/**
 * From email
 *
 * @export
 * @constant {string} FROM_EMAIL
 */
export const FROM_EMAIL = process.env.FROM_EMAIL as string
