// src/controllers/organization.controller.ts
import { Request, Response } from 'express';
import expressAsyncHandler from 'express-async-handler';

import { BaseController } from '@/controllers/base.controller';
import { OrganizationRepository } from '@/repositories/organization.repository';

export class OrganizationController extends BaseController {
  /**
   * OrganizationRepository
   * @type {OrganizationRepository}
   */
  private organizationRepo: OrganizationRepository;

  /**
   * Constructor  - Initialize OrganizationController
   */
  constructor() {
    super();
    this.organizationRepo = new OrganizationRepository();
  }

  /**
   * Get user's all organizations
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   */
  getAllOrganizations = expressAsyncHandler(async (req: Request, res: Response) => {
    try {
      const organizations = await this.organizationRepo.getAll();
      return this.sendResponse(res, { organizations }, 200, 'All organizations');
    } catch (e) {
      const error = e as Error;
      return this.sendError(res, error.message, 500);
    }
  });

  /**
   * Get organization by identifier
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @param {Request} req.params - Request object
   * @param {string} req.params.identifier - Organization identifier
   * @returns {Promise<any>}
   * @memberof OrganizationController
   */
  getOrganization = expressAsyncHandler(async (req: Request, res: Response) => {
    try {
      const { identifier } = req.params;
      const organization = await this.organizationRepo.findByIdentifier(identifier);

      if (!organization) {
        return this.sendError(res, 'Organization not found', 404);
      }
      return this.sendResponse(res, { organization }, 200, 'Organization');
    } catch (e) {
      const error = e as Error;
      return this.sendError(res, error.message, 500);
    }
  });

  /**
   * Create a new organization
   *
   * @param {Request} req - Request object
   * @param {Response} res - Response object
   * @returns {Promise<any>}
   * @memberof OrganizationController
   */
  createOrganization = expressAsyncHandler(async (req: Request, res: Response) => {
    try {
      const organizationData = req.body;

      // Use the authenticated user's ID
      const userId = req.userId;

      const newOrganization = await this.organizationRepo.create({ ...organizationData, userId });
      return this.sendResponse(
        res,
        { organization: newOrganization },
        201,
        'Organization created successfully',
      );
    } catch (e) {
      const error = e as Error;
      return this.sendError(res, error.message, 500);
    }
  });
}
