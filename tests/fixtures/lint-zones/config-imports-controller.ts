// tests/fixtures/lint-zones/config-imports-controller.ts — deliberately
// violates the configs-may-not-import-controllers zone. See lint-gates.test.ts.
import { tenantController } from '@/controllers/tenant.controller'

export const reexported = tenantController
