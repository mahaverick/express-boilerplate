import crypto from 'crypto';

import * as bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { JwtPayload, sign, verify } from 'jsonwebtoken';
import ms from 'ms';

import {
  ACCESS_TOKEN,
  PRIVATE_KEY,
  PUBLIC_KEY,
  REFRESH_TOKEN,
} from '@/configs/constants/constants';
import { tokenModel, TokenType } from '@/database/models/token.model';
import db from '@/services/db.service';
import { logger } from '@/utils/logger.utils';

/**
 * Hashing password
 * This function is used to hash the password and it returns the hash
 *
 * @param {string} password - Password to hash
 * @param {number} saltRounds - Number of salt rounds (default: 10)
 * @returns {Promise<string>} Hashed password
 */
export const hashPassword = async (password: string, saltRounds = 10): Promise<string> => {
  try {
    // Hash the password and return the hash
    const salt = await bcrypt.genSalt(saltRounds);
    return bcrypt.hash(password, salt);
  } catch (e) {
    const error = e as Error;
    logger.error('Failed to hash password: [auth.util] - ', error);
    throw new Error('Failed to hash password');
  }
};

/**
 * Compare password
 * This function is used to compare the password and hash
 *
 * @param {string} password - Plain text password to compare
 * @param {string} hash - Stored hash to compare against
 * @returns {Promise<boolean>} True if password matches, false otherwise
 * @throws {Error} If password compare fails
 */
export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  try {
    // Compare the password and hash
    return await bcrypt.compare(password, hash);
  } catch (e) {
    const error = e as Error;
    logger.error('Error comparing password: [auth.util] - ', error);
    return false;
  }
};

/**
 * Generate access token for user
 *
 * @param {number} userId - user id
 * @param {email} email - user's email
 * @param {string} sessionId - session id
 * @returns {string} The generated access token
 * @throws {Error} If token generation fails
 */
export const generateAccessToken = (userId: number, email: string, sessionId: string): string => {
  if (!ACCESS_TOKEN.expiry) {
    throw new Error('Access token expiry configuration is missing');
  }

  try {
    // Create signed access token
    const accessToken = sign(
      {
        id: userId,
        email: email,
        sessionId: sessionId,
      },
      PRIVATE_KEY,
      {
        algorithm: 'RS256', // RSA SHA-256
        expiresIn: ACCESS_TOKEN.expiry,
      },
    );

    return accessToken;
  } catch (e) {
    const error = e as Error;
    logger.error('Error generating access token: [auth.util] - ', error);
    throw new Error('Failed to generate access token');
  }
};

/**
 * Generate refresh token for user
 *
 * @param {number} userId - User object
 * @param {string} sessionId - session id
 * @param {boolean | undefined} rememberMe - Remember me flag
 * @returns {Promise<string>} The generated refresh token
 * @throws {Error} If token generation or database operation fails
 */
export const generateRefreshToken = async (
  userId: number,
  sessionId: string,
  rememberMe: boolean | undefined,
): Promise<string> => {
  if (!REFRESH_TOKEN.expiry) {
    throw new Error('Refresh token expiry configuration is missing');
  }

  try {
    const refreshToken = sign({ id: userId, sessionId }, PRIVATE_KEY, {
      expiresIn: REFRESH_TOKEN.expiry,
      algorithm: 'RS256', // RSA SHA-256
    });

    // Create a hash of the refresh token
    const rTknHash = hashRefreshToken(refreshToken);

    await db.transaction(async (tx) => {
      // Invalidate old refresh tokens for this user
      await tx
        .delete(tokenModel)
        .where(and(eq(tokenModel.userId, userId), eq(tokenModel.type, TokenType.REFRESH_TOKEN)));

      const expiryMs = rememberMe ? ms(REFRESH_TOKEN.expiry) * 30 : ms(REFRESH_TOKEN.expiry);

      // Store the new refresh token hash
      await tx.insert(tokenModel).values({
        userId: userId,
        type: TokenType.REFRESH_TOKEN,
        value: rTknHash,
        active: true,
        sessionId: sessionId,
        expiresAt: new Date(Date.now() + expiryMs),
      });
    });

    return refreshToken;
  } catch (e) {
    const error = e as Error;
    logger.error('Error generating refresh token: [auth.util] - ', error);
    throw new Error('Failed to generate refresh token');
  }
};

/**
 * This function verifies JWT token and returns the payload
 * @param {string} token - Token to verify
 * @returns {JwtPayload} The decoded token payload
 */
export const verifyToken = (token: string): JwtPayload => {
  try {
    return verify(token, PUBLIC_KEY, { algorithms: ['RS256'] }) as JwtPayload;
  } catch (e) {
    const error = e as Error;

    logger.error('Error verifying token: [auth.util] - ', error);
    throw new Error(error.message);
  }
};

/**
 * This function hashes the refresh token
 * @param {string} refreshToken - Refresh token to hash
 * @returns {string} Hashed refresh token
 */
export const hashRefreshToken = (refreshToken: string): string => {
  try {
    return crypto.createHash('sha256').update(refreshToken).digest('hex');
  } catch (e) {
    const error = e as Error;
    logger.error('Error hashing refresh token: [auth.util] - ', error);
    throw new Error('Failed to hash refresh token');
  }
};
