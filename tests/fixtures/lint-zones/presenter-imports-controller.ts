// tests/fixtures/lint-zones/presenter-imports-controller.ts — deliberately
// violates the presenters-may-not-import-controllers zone. See
// lint-gates.test.ts.
import { tenantController } from '@/controllers/tenant.controller'

export const reexported = tenantController
