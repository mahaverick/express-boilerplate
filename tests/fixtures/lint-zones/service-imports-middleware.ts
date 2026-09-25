// tests/fixtures/lint-zones/service-imports-middleware.ts — deliberately
// violates the services-may-not-import-middlewares zone. See lint-gates.test.ts.
import { errorHandler } from '@/middlewares/error.middleware'

export const handler = errorHandler
