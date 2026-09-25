// tests/fixtures/lint-zones/controller-imports-controller.ts — deliberately
// violates the controllers-may-not-import-controllers zone. See
// lint-gates.test.ts.
import { tenantController } from '@/controllers/tenant.controller'

export const reexported = tenantController
