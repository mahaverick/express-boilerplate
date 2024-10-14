import { Router } from 'express';

import { OrganizationController } from '@/controllers/organization.controller';
import { zodValidate } from '@/middlewares/validation.middleware';
import { createOrganizationSchema } from '@/validators/organization.validator';

const router = Router();
const organizationController = new OrganizationController();

router.get('/', organizationController.getAllOrganizations);
router.get('/:identifier', organizationController.getOrganization);

router.post('/', zodValidate(createOrganizationSchema), organizationController.createOrganization);

export default router;
