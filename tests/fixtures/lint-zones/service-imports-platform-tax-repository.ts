// tests/fixtures/lint-zones/service-imports-platform-tax-repository.ts —
// deliberately imports the cross-tenant tax repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformTaxRepository } from '@/repositories/platform-tax.repository'

export const repository = new PlatformTaxRepository()
