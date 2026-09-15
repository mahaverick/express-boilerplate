// src/lint-fixtures/cycle-a.ts — deliberately circular, via the "@/" ALIAS.
//
// This pair must live under src/, not tests/fixtures/, because tsconfig's
// paths map "@/*" to "./src/*" and nothing else: a fixture anywhere else
// cannot be imported through the alias at all, which is the entire point of
// this fixture. Everything that would otherwise trip over it excludes
// src/lint-fixtures/ explicitly — tsconfig.json (so `pnpm build` never emits
// it), eslint.config.mjs's `ignores` (so `pnpm lint` skips it), and
// vitest.config.ts's coverage exclude. tests/unit/lint-gates.test.ts lints it
// on purpose with `ignore: false`.
//
// See eslint.config.mjs's `import-x/resolver-next` comment: a cwd-relative
// tsconfig `configFile` makes the resolver return RELATIVE paths for "@/*"
// imports specifically, which never === the absolute `physicalFilename`
// no-cycle compares against — so no-cycle silently stops firing on aliased
// imports while still firing on relative ones. The relative-import fixture
// under tests/fixtures/lint-cycle/ cannot detect that; this one can.
import { cycleB } from '@/lint-fixtures/cycle-b'

export const cycleA = (): string => cycleB()
