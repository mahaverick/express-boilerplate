// tests/fixtures/lint-zones/service-imports-platform-email-repository.ts —
// deliberately imports the cross-tenant email repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformEmailRepository } from '@/repositories/platform-email.repository'

export const repository = new PlatformEmailRepository()
