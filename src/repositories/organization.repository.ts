import { and, eq } from 'drizzle-orm';

import { InsertOrganization, organizationModel } from '@/database/models/organization.model';
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
   * Create a new organization
   *
   * @param {InsertOrganization} organizationData - Organization data to insert
   * @returns {Promise<Organization>}
   * @memberof OrganizationRepository
   */
  async create(organizationData: InsertOrganization) {
    const identifier = await this.generateUniqueIdentifier(organizationData.name);

    // Handle establishedAt separately
    if (organizationData.establishedAt) {
      try {
        organizationData.establishedAt = new Date(organizationData.establishedAt);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Error parsing establishedAt:', error);
        delete organizationData.establishedAt;
      }
    }

    const [newOrganization] = await db
      .insert(organizationModel)
      .values({ ...organizationData, identifier })
      .returning();
    return newOrganization;
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

  /**
   * Generate a unique identifier for the organization
   *
   * @param {string} name - Organization name
   * @returns {Promise<string>}
   * @memberof OrganizationRepository
   */
  private async generateUniqueIdentifier(name: string): Promise<string> {
    const baseIdentifier = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .slice(0, 20);
    let identifier = `${baseIdentifier}-${crypto.randomUUID().slice(0, 6)}`;
    let isUnique = false;

    while (!isUnique) {
      const existingOrg = await this.findByIdentifier(identifier);
      if (!existingOrg) {
        isUnique = true;
      } else {
        identifier = `${baseIdentifier}-${crypto.randomUUID().slice(0, 6)}`;
      }
    }

    return identifier;
  }
}
