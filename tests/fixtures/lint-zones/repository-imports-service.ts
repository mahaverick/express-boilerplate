// tests/fixtures/lint-zones/repository-imports-service.ts — deliberately
// violates the repositories-may-not-import-services-except-database zone.
// See lint-gates.test.ts.
import { logger } from '@/services/logger.service'

export const log = logger
