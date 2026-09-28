/**
 * @file Type-level only, no database. Proves `purpose` has no default at
 * the Drizzle schema level, so `NewUserToken` requires it on every
 * insert.
 */
import { describe, expect, it } from 'vitest'
import type { NewUserToken } from '@/database/models/user-token.model'

/**
 * Dropping the default at the schema level, not just the database's, is
 * what makes an insert missing `purpose` a compile error instead of a
 * silent `'refresh'`, the highest-privilege purpose, the one that can
 * mint a session. Only one call site (`createTokenRow`,
 * session.service.ts) calling `create()` is a convention, not something
 * enforced elsewhere; this suite is the gate that survives its erosion.
 * If a future edit re-adds `.default(...)` to `purpose`, it becomes
 * optional in `NewUserToken` again, the `@ts-expect-error` below stops
 * being consumed, and TypeScript reports "Unused '@ts-expect-error'
 * directive" — which `pnpm lint`'s `tsc -p tsconfig.typecheck.json
 * --noEmit` step turns into a real, red gate. The gate itself is
 * checked by the compiler, not by anything this test executes at
 * runtime — `tsc` either reports the unused directive or it doesn't.
 */
describe('user_tokens: `purpose` has no default', () => {
  /**
   * The one runtime `expect` in this block exists for two narrower
   * reasons: it gives `sonarjs/assertions-in-tests` something real to
   * check, and it proves the object literal is a genuine, read value
   * rather than one a future cleanup could quietly delete or
   * `void`-away, which would also delete the compile-time check it
   * exists to trigger.
   */
  it('omitting `purpose` from a NewUserToken literal is a compile error', () => {
    // @ts-expect-error — TokenPurpose has no fallback; if this stops erroring, purpose silently grew a default again and every create() call that forgets it would mint a 'refresh' row instead of failing to compile.
    const missingPurpose: NewUserToken = {
      userId: 'user-id',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(),
    }
    expect(missingPurpose.userId).toBe('user-id')
  })
})
