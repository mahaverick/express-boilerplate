// src/lint-fixtures/cycle-b.ts — the other half of the aliased cycle.
// See cycle-a.ts for why this pair lives under src/.
import { cycleA } from '@/lint-fixtures/cycle-a'

export const cycleB = (): string => cycleA()
