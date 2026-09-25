// tests/fixtures/lint-zones/controller-imports-repository.ts — deliberately
// violates the controllers-may-not-import-repositories zone. Linted at a
// synthetic src/controllers/*.ts path by tests/unit/lint-gates.test.ts.
import { TenantRepository } from '@/repositories/tenant.repository'

export const repository = new TenantRepository()
