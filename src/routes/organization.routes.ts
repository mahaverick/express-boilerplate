import { Router } from 'express';

import { OrganizationController } from '@/controllers/organization.controller';

const router = Router();
const organizationController = new OrganizationController();

router.get('/', organizationController.getAllOrganizations);
router.get('/:identifier', organizationController.getOrganization);

export default router;
