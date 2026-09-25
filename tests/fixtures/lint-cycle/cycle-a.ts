// tests/fixtures/lint-cycle/cycle-a.ts — deliberately circular, via the "@/"
// ALIAS (this pair's own tsconfig.json maps "@/*" to "./*", not to src/).
// Proves no-cycle follows an aliased import. It is linted under its own
// resolver and tsconfig, so it does not guard eslint.config.mjs's resolver
// settings; lint-gates.test.ts's real-config no-cycle case does that.
import { cycleB } from '@/cycle-b'

export const cycleA = (): string => cycleB()
