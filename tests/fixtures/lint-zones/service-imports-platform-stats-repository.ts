// tests/fixtures/lint-zones/service-imports-platform-stats-repository.ts —
// deliberately imports the cross-tenant stats repository from outside
// services/platform-*.service.ts. See lint-gates.test.ts.
import { PlatformStatsRepository } from '@/repositories/platform-stats.repository'

export const repository = new PlatformStatsRepository()
