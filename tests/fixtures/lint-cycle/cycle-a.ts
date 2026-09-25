// tests/fixtures/lint-cycle/cycle-a.ts — deliberately circular, via the "@/"
// ALIAS (this pair's own tsconfig.json maps "@/*" to "./*", not to src/).
// See lint-gates.test.ts.
//
// See eslint.config.mjs's `import-x/resolver-next` comment: a cwd-relative
// tsconfig `configFile` makes the resolver return RELATIVE paths for "@/*"
// imports specifically, which never === the absolute `physicalFilename`
// no-cycle compares against — so no-cycle silently stops firing on aliased
// imports while still firing on relative ones. The relative-import pair
// beside this one (a.ts/b.ts) cannot detect that; this one can.
import { cycleB } from '@/cycle-b'

export const cycleA = (): string => cycleB()
