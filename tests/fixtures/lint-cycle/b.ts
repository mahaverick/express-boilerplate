// tests/fixtures/lint-cycle/b.ts — deliberately circular. See lint-gates.test.ts.
import { a } from './a'

export const b = (): string => a()
