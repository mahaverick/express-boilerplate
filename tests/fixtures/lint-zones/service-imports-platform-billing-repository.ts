// tests/fixtures/lint-zones/service-imports-platform-billing-repository.ts —
// deliberately imports the cross-tenant billing repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformBillingRepository } from '@/repositories/platform-billing.repository'

export const repository = new PlatformBillingRepository()
