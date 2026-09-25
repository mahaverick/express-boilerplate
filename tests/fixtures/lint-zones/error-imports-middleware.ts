// tests/fixtures/lint-zones/error-imports-middleware.ts — deliberately
// violates the errors-may-not-import-middlewares zone. See lint-gates.test.ts.
import { errorHandler } from '@/middlewares/error.middleware'

export const handler = errorHandler
