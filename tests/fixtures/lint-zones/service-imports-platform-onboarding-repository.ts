// tests/fixtures/lint-zones/service-imports-platform-onboarding-repository.ts —
// deliberately imports the cross-tenant onboarding repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformOnboardingRepository } from '@/repositories/platform-onboarding.repository'

export const repository = new PlatformOnboardingRepository()
