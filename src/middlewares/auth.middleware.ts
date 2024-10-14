// src/middleware/auth.middleware.ts

import { NextFunction, Request, Response } from 'express';

import { AppError } from '@/middlewares/error.middleware';
import { verifyToken } from '@/utils/auth.utils';
import { logger } from '@/utils/logger.utils';

/**
 * Middleware to require authentication
 * @param req Request object
 * @param res Response object
 * @param next Next function
 */
export const requireAuthentication = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Authorization header missing. Please provide a valid token.');
    }

    const accessTokenParts = authHeader.split(' ');
    const accessToken = accessTokenParts[1];

    if (!accessToken) {
      throw new Error('Access token is missing. Please provide a valid token.');
    }

    const decoded = verifyToken(accessToken);

    // Attach authenticated user and Access Token to request object
    req.userId = decoded.userId;
    req.sessionId = decoded.sessionId;
    req.token = accessToken;
    next();
  } catch (e) {
    const error = e as AppError;

    logger.error('Error verifying token: [auth.middleware] - ', error);

    error.code = error.code || 'AUTHENTICATION_ERROR';
    error.statusCode = 498; // 498 is not a standard HTTP status code, but it's commonly used for expired tokens or invalid tokens

    if (error.message === 'jwt expired') {
      error.message = 'Access token expired. Please refresh your token.';
      error.code = 'ACCESS_TOKEN_EXPIRED';
      res.setHeader('X-Access-Token-Expired', 'true');
    }

    if (error.message === 'jwt malformed') {
      error.message = 'Invalid access token. Please provide a valid token.';
      error.code = 'ACCESS_TOKEN_INVALID';
      res.setHeader('X-Access-Token-Invalid', 'true');
    }

    next(error);
  }
};
