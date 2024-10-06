import crypto from 'crypto';

import { and, eq } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

import { InsertToken, Token, tokenModel, TokenType } from '@/database/models/token.model';
import { BaseRepository } from '@/repositories/base.repository';
import db from '@/services/db.service';

export class TokenRepository extends BaseRepository {
  /**
   * Create a new token
   *
   * @param {Partial<InsertToken>} data - Token data
   * @param {PgTransaction<any, any, any>} tx - Database transaction
   *
   * @returns {Promise<Token>}
   * @memberof TokenRepository
   */
  async create(
    data: Omit<InsertToken, 'value'>,
    tx?: PgTransaction<any, any, any>,
  ): Promise<Token> {
    const tokenValue = crypto.randomBytes(32).toString('hex');
    const [token] = await (tx || db)
      .insert(tokenModel)
      .values({
        value: tokenValue,
        active: true,
        provider: 'boilerplate',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        ...data,
      })
      .returning();

    return token;
  }

  /**
   * Create an email verification token
   *
   * @param {number} userId - User ID
   * @param {PgTransaction<any, any, any>} tx - Database transaction
   * @returns {Promise<Token>}
   * @memberof TokenRepository
   */
  async createEmailVerificationToken(userId: number, tx?: PgTransaction<any, any, any>) {
    return this.create({ userId, type: TokenType.EMAIL_VERIFICATION }, tx);
  }

  /**
   * Create a password reset token
   *
   * @param {number} userId - User ID
   * @param {PgTransaction<any, any, any>} tx - Database transaction
   * @returns {Promise<Token>}
   * @memberof TokenRepository
   */
  async createPasswordResetToken(userId: number, tx?: PgTransaction<any, any, any>) {
    return this.create({ userId, type: TokenType.PASSWORD_RESET }, tx);
  }

  /**
   * Get all tokens for user by UserId
   *
   * @param {number|string} userId - User ID
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async findByUserId(userId: number | string) {
    const tokens = await db.query.tokenModel.findMany({
      where: and(eq(tokenModel.userId, Number(userId)), eq(tokenModel.active, true)),
    });
    return tokens;
  }

  /**
   * Get token by userId and type
   *
   * @param {number} userId - User ID
   * @param {TokenType} type - Token type
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async findByUserIdAndType(userId: number, type: TokenType) {
    const token = await db.query.tokenModel.findFirst({
      where: and(
        eq(tokenModel.userId, userId),
        eq(tokenModel.type, type),
        eq(tokenModel.active, true),
      ),
    });
    return token;
  }

  /**
   * Get token by value
   *
   * @param {string} value - Token value
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async findByValue(value: string) {
    const token = await db.query.tokenModel.findFirst({
      where: and(eq(tokenModel.value, value)),
    });
    return token;
  }

  /**
   * Get token by value and type
   *
   * @param {string} value - Token value
   * @param {TokenType} type - Token type
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async findByValueAndType(value: string, type: TokenType) {
    const token = await db.query.tokenModel.findFirst({
      where: and(eq(tokenModel.value, value), eq(tokenModel.type, type)),
      with: { user: true },
    });
    return token;
  }

  /**
   * delete token by id
   *
   * @param {number} id - id
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async delete(id: number) {
    await db.delete(tokenModel).where(eq(tokenModel.id, id));
  }

  /**
   * Delete token by session ID
   *
   * @param {string} sessionId - Session ID
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async deleteBySessionId(sessionId: string) {
    await db.delete(tokenModel).where(eq(tokenModel.sessionId, sessionId));
  }

  /**
   * delete token by value
   *
   * @param {string} value - value
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async deleteByValue(value: string) {
    await db.delete(tokenModel).where(eq(tokenModel.value, value));
  }

  /**
   * Deactivate token by id
   *
   * @param {number} tokenId - Token ID
   * @returns {Promise<any>}
   * @memberof TokenRepository
   */
  async deactivateToken(tokenId: number) {
    const [token] = await db
      .update(tokenModel)
      .set({ active: false })
      .where(eq(tokenModel.id, tokenId))
      .returning();
    return token;
  }
}
