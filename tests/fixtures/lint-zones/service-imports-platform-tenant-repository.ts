// tests/fixtures/lint-zones/service-imports-platform-tenant-repository.ts —
// deliberately imports the cross-tenant repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformTenantRepository } from '@/repositories/platform-tenant.repository'

export const repository = new PlatformTenantRepository()
