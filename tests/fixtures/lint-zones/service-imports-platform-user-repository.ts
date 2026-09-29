// tests/fixtures/lint-zones/service-imports-platform-user-repository.ts —
// deliberately imports the cross-tenant user repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformUserRepository } from '@/repositories/platform-user.repository'

export const repository = new PlatformUserRepository()
