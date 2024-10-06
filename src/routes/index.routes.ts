import { Request, Response, Router } from 'express';

import { requireAuthentication } from '@/middlewares/auth.middleware';
import authRoutes from '@/routes/auth.routes';
import organizationRoutes from '@/routes/organization.routes';
import userRoutes from '@/routes/user.routes';

const router: Router = Router();

router.get('/', function (req: Request, res: Response) {
  res.send('Hello, Welcome to Boilerplate API🙃 !!');
});

// without authentication
router.use('/auth', authRoutes);

// require authentication
router.use('/users', requireAuthentication, userRoutes);
router.use('/organizations', requireAuthentication, organizationRoutes);

export default router;
