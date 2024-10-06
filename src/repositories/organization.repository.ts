import { and, eq } from 'drizzle-orm';

import { organizationModel } from '@/database/models/organization.model';
import { userModel } from '@/database/schema';
import { BaseRepository } from '@/repositories/base.repository';
import db from '@/services/db.service';

const DEFAULT_SENSITIVE_COLUMNS = ['id', 'userId', 'deletedAt'];

export class OrganizationRepository extends BaseRepository {
  /**
   * Get all users
   *
   * @returns {Promise<any>}
   * @memberof UserRepository
   */
  async getAll() {
    return db.query.organizationModel.findMany({
      where: this.withSoftDelete(organizationModel.deletedAt),
      columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
      with: {
        user: {
          columns: this.omitUserSensitiveColumns(),
        },
      },
    });
  }
  /**
   * Get organization by identifier
   *
   * @param {string} identifier - Organization identifier
   * @returns {Promise<any>}
   * @memberof OrganizationRepository
   */
  async findByIdentifier(identifier: string) {
    const organization = await db.query.organizationModel.findFirst({
      columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
      where: eq(organizationModel.identifier, identifier),
    });
    return organization;
  }

  /**
   * Get all organizations for user by UserId
   *
   * @param {number|string} userId - User ID
   * @returns {Promise<any>}
   * @memberof OrganizationRepository
   */
  async findByUserId(userId: number | string) {
    const organizations = await db.query.organizationModel.findMany({
      columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
      where: and(eq(organizationModel.userId, Number(userId)), eq(organizationModel.active, true)),
    });
    return organizations;
  }

  /**
   * Get all organizations for user by UserId
   *
   * @param {string} username - User ID
   * @returns {Promise<any>}
   * @memberof OrganizationRepository
   */
  async findByUsername(username: string) {
    try {
      const user = await db.query.userModel.findFirst({ where: eq(userModel.username, username) });
      if (!user) {
        throw new Error('User not found');
      }
      const organizations = await db.query.organizationModel.findMany({
        columns: this.omitSensitiveColumns(...DEFAULT_SENSITIVE_COLUMNS),
        where: and(eq(organizationModel.userId, user.id), eq(organizationModel.active, true)),
      });
      return organizations;
    } catch (e) {
      const error = e as Error;
      throw new Error(error.message);
    }
  }

  /**
   * delete organization by identifier
   *
   * @param {string} identifier - identifier
   * @returns {Promise<any>}
   * @memberof OrganizationRepository
   */
  async deleteByIdentifier(identifier: string) {
    await db.delete(organizationModel).where(eq(organizationModel.identifier, identifier));
  }
}
