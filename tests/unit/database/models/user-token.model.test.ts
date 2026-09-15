// tests/unit/database/models/user-token.model.test.ts
//
// Type-level only, no database. Proves `purpose` has NO default at the
// Drizzle schema level, so `NewUserToken` requires it on every insert.
//
// WHY THIS FILE EXISTS. Migration 0003 gave `purpose` a temporary
// `DEFAULT 'refresh'` — needed only to backfill pre-existing rows in the
// same statement that added the `NOT NULL` constraint — and 0004 dropped
// it once that one-time backfill was done (see user-token.model.ts's own
// comment on this column). Dropping the default at the SCHEMA level too
// (not just the database's) is what makes an insert missing `purpose` a
// compile error instead of a silent `'refresh'` — the highest-privilege
// purpose, the one that can mint a session. "Only one call site
// (`createTokenRow`, token.utilities.ts) ever calls `create()`" is a
// convention; a convention is exactly what erodes first in a project
// derived from this boilerplate. This file is the gate that survives that
// erosion: if a future edit re-adds `.default(...)` to `purpose` for a
// convenient migration, `purpose` becomes optional in `NewUserToken` again,
// the `@ts-expect-error` below stops being consumed, and TypeScript reports
// "Unused '@ts-expect-error' directive" — which `pnpm lint`'s
// `tsc -p tsconfig.typecheck.json --noEmit` step turns into a real, red
// gate, without anyone having to remember this reasoning.
//
// No runtime assertions: the entire point is checked by the compiler, not
// by anything this test executes at runtime. The `it` block exists only so
// this file behaves like every other test file under `pnpm test`; the
// object literal inside it is type-checked but never read.
import { describe, expect, it } from 'vitest'
import type { NewUserToken } from '@/database/models/user-token.model'

describe('user_tokens: `purpose` has no default', () => {
  it('omitting `purpose` from a NewUserToken literal is a compile error', () => {
    // @ts-expect-error — `purpose` is required: TokenPurpose has no
    // fallback, on purpose. If this stops erroring, `purpose` silently
    // grew a default again and every `create()` call that forgets it would
    // mint a 'refresh' row instead of failing to compile.
    const missingPurpose: NewUserToken = {
      userId: 'user-id',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(),
    }
    // A real assertion, not a throwaway: proves the literal above is
    // actually read, not merely constructed and discarded — the type
    // error this test exists to pin down is on the object literal's
    // *shape*, so the object has to be a genuine value, not a `void`-ed
    // one a future cleanup could delete without weakening the check.
    expect(missingPurpose.userId).toBe('user-id')
  })
})
