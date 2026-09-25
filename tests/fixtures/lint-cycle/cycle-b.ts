// tests/fixtures/lint-cycle/cycle-b.ts — the other half. See cycle-a.ts.
import { cycleA } from '@/cycle-a'

export const cycleB = (): string => cycleA()
