import crypto from 'crypto';

import { Request, Response } from 'express';
import { ZodError } from 'zod';

import { REFRESH_TOKEN, SESSION_TOKEN } from '@/configs/constants/constants';
import { AuthController } from '@/controllers/auth.controller';
import { TokenRepository } from '@/repositories/token.repository';
import { UserRepository } from '@/repositories/user.repository';
import {
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyToken,
} from '@/utils/auth.utils';

jest.mock('@/repositories/user.repository');
jest.mock('@/repositories/token.repository');
jest.mock('@/utils/auth.utils');
jest.mock('@/services/mailer.service');

jest.mock('zod', () => ({
  ZodError: {
    create: jest.fn(),
  },
}));

describe('AuthController', () => {
  let authController: AuthController;
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    authController = new AuthController();
    req = {
      body: {},
      cookies: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
  });

  describe('login', () => {
    it('should return validation error if validation fails', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => false,
        array: () => [{ msg: 'Validation error' }],
      });
      const nextFn = jest.fn();

      await authController.login(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Validation error' }),
      );
    });

    it('should return error if user is not found', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => true,
      });
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue(
        null,
      );

      req.body = { email: 'test@example.com', password: 'password' };

      const nextFn = jest.fn();
      await authController.login(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Wrong credentials!!' }),
      );
    });

    it('should return error if user email is not verified', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => true,
      });
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue({
        email: 'test@example.com',
        emailVerifiedAt: null,
      });

      req.body = { email: 'test@example.com', password: 'password' };

      const nextFn = jest.fn();
      await authController.login(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Email is not verified!' }),
      );
    });

    it('should return error if password does not match', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => true,
      });
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue({
        emailVerifiedAt: new Date(),
        password: 'hashedPassword',
      });
      (comparePassword as jest.Mock).mockResolvedValue(false);

      req.body = { email: 'test@example.com', password: 'password' };

      const nextFn = jest.fn();
      await authController.login(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Wrong credentials!!' }),
      );
    });

    it('should login user and set cookies', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => true,
      });
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue({
        id: 'userId',
        email: 'test@example.com',
        emailVerifiedAt: new Date(),
        password: 'hashedPassword',
      });
      (comparePassword as jest.Mock).mockResolvedValue(true);
      (generateAccessToken as jest.Mock).mockReturnValue('accessToken');
      (generateRefreshToken as jest.Mock).mockResolvedValue('refreshToken');
      jest.spyOn(crypto, 'randomBytes').mockReturnValue({ toString: () => 'sessionId' } as any);

      req.body = { email: 'test@example.com', password: 'password' };

      const nextFn = jest.fn();

      await authController.login(req as Request, res as Response, nextFn);

      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_TOKEN.cookie.name,
        'refreshToken',
        REFRESH_TOKEN.cookie.options,
      );
      expect(res.cookie).toHaveBeenCalledWith(
        SESSION_TOKEN.cookie.name,
        'sessionId',
        SESSION_TOKEN.cookie.options,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Login successful',
          data: { accessToken: 'accessToken' },
        }),
      );
    });
  });

  describe('register', () => {
    it('should return validation error if validation fails', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => false,
        array: () => [{ msg: 'Validation error' }],
      });

      const nextFn = jest.fn();
      await authController.register(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Validation error' }),
      );
    });

    it('should register user successfully', async () => {
      (ZodError.create as jest.Mock).mockReturnValue({
        isEmpty: () => true,
      });
      (UserRepository.prototype.create as jest.Mock).mockResolvedValue({});

      req.body = {
        username: 'username',
        email: 'test@example.com',
        password: 'password',
        firstName: 'First',
        lastName: 'Last',
      };

      const nextFn = jest.fn();

      await authController.register(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'User registered successfully' }),
      );
    });
  });

  describe('refresh', () => {
    it('should return error if refresh token is missing', async () => {
      req.cookies = {};

      const nextFn = jest.fn();
      await authController.refresh(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Refresh token not found' }),
      );
    });

    it('should return error if refresh token is invalid', async () => {
      req.cookies = { [REFRESH_TOKEN.cookie.name]: 'invalidToken' };
      (verifyToken as jest.Mock).mockReturnValue(null);

      const nextFn = jest.fn();
      await authController.refresh(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Invalid refresh token' }),
      );
    });

    it('should refresh access token successfully', async () => {
      req.cookies = { [REFRESH_TOKEN.cookie.name]: 'validToken' };
      req.sessionId = 'sessionId';
      (verifyToken as jest.Mock).mockReturnValue({ sessionId: 'sessionId' });
      (hashRefreshToken as jest.Mock).mockReturnValue('hashedToken');
      (TokenRepository.prototype.findByValueAndType as jest.Mock).mockResolvedValue({
        sessionId: 'sessionId',
        user: { id: 'userId', email: 'test@example.com' },
      });
      (generateAccessToken as jest.Mock).mockReturnValue('newAccessToken');

      const nextFn = jest.fn();
      await authController.refresh(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Access token refreshed',
          data: { accessToken: 'newAccessToken' },
        }),
      );
    });
  });

  describe('logout', () => {
    it('should logout user and clear cookies', async () => {
      req.sessionId = 'sessionId';
      (TokenRepository.prototype.deleteBySessionId as jest.Mock).mockResolvedValue({});

      const nextFn = jest.fn();
      await authController.logout(req as Request, res as Response, nextFn);

      expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_TOKEN.cookie.name);
      expect(res.clearCookie).toHaveBeenCalledWith(SESSION_TOKEN.cookie.name);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Logout successful' }),
      );
    });
  });

  describe('verifyEmail', () => {
    it('should return error if token is invalid', async () => {
      req.body = { token: 'invalidToken' };
      (TokenRepository.prototype.findByValueAndType as jest.Mock).mockResolvedValue(null);

      const nextFn = jest.fn();
      await authController.verifyEmail(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Invalid or expired verification token' }),
      );
    });

    it('should verify email successfully', async () => {
      req.body = { token: 'validToken' };
      (TokenRepository.prototype.findByValueAndType as jest.Mock).mockResolvedValue({
        id: 1,
        userId: 1,
        active: true,
      });
      (UserRepository.prototype.findByIdWithSensitiveColumns as jest.Mock).mockResolvedValue({
        id: 1,
        email: 'test@example.com',
        emailVerifiedAt: null,
      });
      (UserRepository.prototype.verifyEmail as jest.Mock).mockResolvedValue({});
      (TokenRepository.prototype.deactivateToken as jest.Mock).mockResolvedValue({});

      const nextFn = jest.fn();
      await authController.verifyEmail(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Email verified successfully' }),
      );
    });
  });

  describe('resendVerificationEmail', () => {
    it('should return error if email is not found', async () => {
      req.body = { email: 'nonexistent@example.com' };
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue(
        null,
      );

      const nextFn = jest.fn();
      await authController.resendVerificationEmail(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'User not found' }));
    });

    it('should resend verification email successfully', async () => {
      req.body = { email: 'test@example.com' };
      (UserRepository.prototype.findByEmailWithSensitiveColumns as jest.Mock).mockResolvedValue({
        id: 1,
        email: 'test@example.com',
        emailVerifiedAt: null,
      });
      (TokenRepository.prototype.createEmailVerificationToken as jest.Mock).mockResolvedValue({
        value: 'newToken',
      });

      const nextFn = jest.fn();
      await authController.resendVerificationEmail(req as Request, res as Response, nextFn);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Verification email sent successfully' }),
      );
    });
  });

  // Add more test cases for forgotPassword, verifyPasswordResetToken, and resetPassword methods
});
