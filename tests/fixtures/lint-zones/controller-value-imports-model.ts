// tests/fixtures/lint-zones/controller-value-imports-model.ts —
// deliberately a VALUE (not type-only) import from database/models, which
// @typescript-eslint/no-restricted-imports rejects for src/controllers/**
// even though a type-only import of the same module is allowed. See
// lint-gates.test.ts.
import { userModel } from '@/database/models/user.model'

export const table = userModel
