import { and, eq, isNotNull } from 'drizzle-orm';

import { InsertUser, userModel } from '@/database/models/user.model';
import { providerModel } from '@/database/schema';
import { BaseRepository } from '@/repositories/base.repository';
import { TokenRepository } from '@/repositories/token.repository';
import db from '@/services/db.service';
import { hashPassword } from '@/utils/auth.utils';

const DEFAULT_SENSITIVE_COLUMNS = ['id', 'userId', 'deletedAt'];

export class UserRepository extends BaseRepository {
  /**
   * Token repository
   *
   * @private
   * @type {TokenRepository}
   * @memberof UserRepository
   */
  private tokenRepo: TokenRepository;

  /**
   * Constructor
   *
   * @memberof UserRepository
   */
  constructor() {
    super();
    this.tokenRepo = new TokenRepository();
  }

  /**
   * Sanitize user data, which will remove id, password, createdAt, updatedAt, deletedAt fields
   *
   * @param {InsertUser} user - User object
   * @returns {InsertUser}
   *
   * @memberof UserRepository
   */
  sanitize(user: InsertUser) {
    if (user) {
      delete user.id;
      delete user.password;

      delete user.emailVerifiedAt;
      delete user.phoneVerifiedAt;
      delete user.lastLoggedInAt;

      delete user.createdAt;
      delete user.updatedAt;
      delete user.deletedAt;
    }
    return user;
  }

  /**
   * Get all users
   *
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async getAll() {
    return db.query.userModel.findMany({
      where: this.withSoftDelete(userModel.deletedAt),
      columns: this.omitUserSensitiveColumns(),
      with: {
        providers: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
        organizations: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
  }

  /**
   * Create a new user
   *
   * @param {string} username - User's username
   * @param {string} email - User's email
   * @param {string} password - User's password
   * @param {string} firstName - User's first name
   * @param {string} middleName - User's middle name (default: '')
   * @param {string} lastName - User's last name (default: '')
   * @param {string} active - User's active status (default: false)
   * @param {Date} emailVerifiedAt - User's active status (default: null)
   *
   * @returns {Promise<{user: User, tokenValue: string}>}
   * @memberof UserRepository
   */
  async create(userData: InsertUser) {
    try {
      const userAndToken = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(userModel)
          .values({
            ...userData,
            password: await hashPassword(userData.password ? userData.password : ''),
          })
          .returning();

        await tx.insert(providerModel).values({
          userId: user.id,
          type: 'email',
          active: true,
        });

        // if email verified is provided then we don't need to create verification token
        let tokenValue = null;
        if (!user.emailVerifiedAt) {
          const token = await this.tokenRepo.createEmailVerificationToken(user.id, tx);
          tokenValue = token.value;
        }
        return { user, tokenValue };
      });

      return userAndToken;
    } catch (e) {
      const error = e as Error;
      throw error;
    }
  }

  /**
   * Get single user by id
   *
   * @param {number|string} userId - User ID
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async findById(userId: number | string) {
    const user = await db.query.userModel.findFirst({
      where: and(eq(userModel.id, Number(userId)), this.withSoftDelete(userModel.deletedAt)),
      columns: this.omitUserSensitiveColumns(),
      with: {
        providers: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
        organizations: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user;
  }

  /**
   * Get single user by id without omitting any columns
   *
   * @param {number} id - User id
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async findByIdWithSensitiveColumns(id: number) {
    const user = await db.query.userModel.findFirst({
      where: and(eq(userModel.id, id), this.withSoftDelete(userModel.deletedAt)),
      with: {
        providers: true,
        organizations: true,
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user;
  }

  /**
   * Get single user by email
   *
   * @param {string} email - User email
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async findByEmail(email: string) {
    const user = await db.query.userModel.findFirst({
      where: and(eq(userModel.email, email), this.withSoftDelete(userModel.deletedAt)),
      columns: this.omitUserSensitiveColumns(),
      with: {
        providers: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
        organizations: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user;
  }

  /**
   * Get single user by email without omitting any columns
   *
   * @param {string} email - User email
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async findByEmailWithSensitiveColumns(email: string) {
    const user = await db.query.userModel.findFirst({
      where: and(eq(userModel.email, email), this.withSoftDelete(userModel.deletedAt)),
      with: {
        providers: true,
        organizations: true,
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user;
  }

  /**
   * Get single user by username
   *
   * @param {string} username - User username
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async findByUsername(username: string) {
    const user = db.query.userModel.findFirst({
      where: and(eq(userModel.username, username), this.withSoftDelete(userModel.deletedAt)),
      columns: this.omitUserSensitiveColumns(),
      with: {
        providers: true,
        organizations: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user;
  }

  /**
   * Soft deletes a user
   *
   * @param {number} userId - User ID
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async softDelete(userId: number) {
    const [user] = await db
      .update(userModel)
      .set({ deletedAt: this.getCurrentTimestamp() })
      .where(eq(userModel.id, userId))
      .returning();
    return user;
  }

  /**
   * Restore a soft deleted user
   *
   * @param {number} userId - User ID
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async restoreSoftDelete(userId: number) {
    const [user] = await db
      .update(userModel)
      .set({ deletedAt: null })
      .where(eq(userModel.id, userId))
      .returning();
    return user;
  }

  /**
   * Get user's organizations
   *
   * @param {string} username - Username
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async getUsersOrganizationsByUsername(username: string) {
    const user = await db.query.userModel.findFirst({
      where: and(eq(userModel.username, username), this.withSoftDelete(userModel.deletedAt)),
      with: {
        organizations: {
          columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        },
      },
      extras: {
        emailVerified: isNotNull(userModel.emailVerifiedAt).as('email_verified'),
        phoneVerified: isNotNull(userModel.phoneVerifiedAt).as('phone_verified'),
      },
    });
    return user?.organizations || [];
  }

  /**
   * Verify user's email
   *
   * @param {number} userId - User ID
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async verifyEmail(userId: number) {
    const [user] = await db
      .update(userModel)
      .set({ emailVerifiedAt: this.getCurrentTimestamp() })
      .where(eq(userModel.id, userId))
      .returning();
    return user;
  }

  /**
   * Update user's password
   *
   * @param {number} userId - User ID
   * @param {string} newPassword - New password
   * @returns {Promise<User>}
   * @memberof UserRepository
   */
  async updatePassword(userId: number, newPassword: string) {
    const hashedPassword = await hashPassword(newPassword);
    const [user] = await db
      .update(userModel)
      .set({ password: hashedPassword })
      .where(eq(userModel.id, userId))
      .returning();
    return user;
  }

  // Add more methods as needed...
}
