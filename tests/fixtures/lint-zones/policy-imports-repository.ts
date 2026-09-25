// tests/fixtures/lint-zones/policy-imports-repository.ts — deliberately
// violates the policies-may-not-import-repositories zone. See lint-gates.test.ts.
import { TenantRepository } from '@/repositories/tenant.repository'

export const repository = new TenantRepository()
