// tests/fixtures/lint-cycle/a.ts — deliberately circular. See lint-gates.test.ts.
import { b } from './b'

export const a = (): string => b()
