// tests/helpers/mutate.ts
//
// WHY THIS EXISTS. B1 and B2's most valuable verification technique was
// proving a test goes RED by temporarily breaking the code it protects —
// not asserting a test passes, but demonstrating it fails when the
// protection is removed. Doing that by hand-editing a file under `src/`
// found real defects, but it also put a live vulnerability on disk, in a
// SHARED git worktree, for however long the edit lasted: four separate
// CRITICAL/HIGH security-scanner alerts fired on states that were never
// meant to be committed, and once a mass-assignment hole sat in a TRACKED
// file while a crashed agent's work was being rescued with `git add -A`. It
// was not committed, but only because of a marker-grep added after an
// earlier near-miss — the safety net was a convention, not a guarantee.
//
// This module is that guarantee instead: every helper here mutates
// something held only in this process's memory, for the lifetime of one
// `run` callback, and always restores it in a `finally` — including when
// `run` throws or its returned promise rejects. No file under `src/` is
// ever opened for writing. `git status --porcelain` cannot show a change
// that was never written.
//
// TWO VARIANTS, because the real cases this was built against do not share
// one shape:
//
//   - withMutatedMethod: swap ONE METHOD on a shared, already-mutable
//     object — almost always `SomeClass.prototype` — for the duration of a
//     callback, then restore it. This is the SHORT path and should be
//     reached for first. Most security-relevant behaviour in this codebase
//     is a method called through a module-private instance of an exported
//     repository class (e.g. `const userTokenRepository = new
//     UserTokenRepository()` in session.service.ts): overriding
//     `UserTokenRepository.prototype.revokeAllForSession` reaches every
//     existing instance, including one already constructed, with a single
//     property assignment. No module reloading, no dynamic import, no risk
//     of leaking connections opened by a re-evaluated module graph.
//
//   - withMutatedModule: replace one or more of a MODULE's own named
//     exports for the duration of a callback, via `vi.doMock` +
//     `vi.resetModules`, then restore. Reach for this only when
//     withMutatedMethod does not apply — a plain function captured BY
//     VALUE at another module's load time has no shared mutable object a
//     property assignment can reach. `loginRateLimitKey`
//     (rate-limit.middleware.ts) is exactly this shape: it is passed as
//     `keyGenerator: loginRateLimitKey` inside a factory function, so the
//     only way to change what a caller of that factory sees is to
//     intercept module resolution itself before the factory runs.
//
//     This variant is not free: `vi.resetModules()` discards this worker's
//     ENTIRE module cache, not just the mutated module, so `loadSubject`
//     re-evaluates every module between it and the mutated dependency —
//     including ones with real side effects at module scope.
//     `database.service.ts` opens a fresh postgres connection pool (max 2)
//     every time it is re-evaluated, and nothing closes the previous one;
//     each call to this helper against a subject that transitively imports
//     it leaks up to 2 connections for the life of the worker process.
//     Acceptable for the handful of calls a mutation proof needs; do not
//     call it in a loop or from a test that runs often.
import { vi } from 'vitest'

/**
 * Replace one method on a shared object — typically `SomeClass.prototype`
 * — for the duration of `run`, restoring the original implementation
 * afterwards even if `run` throws synchronously or its returned promise
 * rejects.
 *
 * Plain property assignment, not `vi.spyOn`: the original value is saved
 * once, the replacement is assigned, and the original is written back in a
 * `finally` — no mocking framework state to reconcile with this project's
 * vitest config (which sets neither `restoreMocks` nor `mockReset`), and
 * no generic-overload gymnastics fighting `vi.spyOn`'s own typing. A
 * caller that wants call-tracking can pass a `vi.fn(implementation)` as
 * `implementation` and inspect its `.mock.calls` directly — it is still
 * just a value being assigned and restored.
 * @param target - The object carrying the method, typically an exported class's `.prototype`.
 * @param methodName - The method to replace for the duration of `run`.
 * @param implementation - The stand-in implementation to install.
 * @param run - The test logic to execute while the mutation is active.
 * @returns Resolves once `run` settles and the original method is restored.
 */
export async function withMutatedMethod<TTarget extends object, TMethod extends keyof TTarget>(
  target: TTarget,
  methodName: TMethod,
  implementation: TTarget[TMethod],
  run: () => Promise<void> | void
): Promise<void> {
  const original = target[methodName]
  target[methodName] = implementation
  try {
    await run()
  } finally {
    target[methodName] = original
  }
}

/**
 * Replace one or more of a module's named exports for the duration of
 * `run`, restoring the real module afterwards even if `run` throws
 * synchronously or its returned promise rejects.
 *
 * `loadSubject` must be a thunk whose body is a literal `import('...')`
 * expression written at the CALL SITE — `() =>
 * import('@/services/session.service')`, never a path built from a
 * variable and handed to this function as a string. A literal import
 * specifier is what lets the bundler resolve this project's `@/` alias and
 * infer `TSubject` without an unsafe cast; this function only calls the
 * thunk, after the mutation is installed and the module cache is cleared,
 * so the subject's own imports resolve to the mutated dependency.
 * @param dependencyPath - The module specifier of the dependency to mutate, exactly as `src/` imports it (e.g. `@/repositories/user-token.repository`).
 * @param overrides - Replacement values, merged over the dependency's real exports.
 * @param loadSubject - Loads the module under test; see this function's own comment for why it must be a literal `import()` thunk.
 * @param run - The test logic to execute against the freshly-loaded subject while the mutation is active.
 * @returns Resolves once `run` settles and the real module is restored.
 */
export async function withMutatedModule<TModule extends object, TSubject>(
  dependencyPath: string,
  overrides: Partial<TModule>,
  loadSubject: () => Promise<TSubject>,
  run: (subject: TSubject) => Promise<void> | void
): Promise<void> {
  vi.doMock(dependencyPath, async (importOriginal) => {
    const actual = await importOriginal<TModule>()
    return { ...actual, ...overrides }
  })
  vi.resetModules()

  try {
    const subject = await loadSubject()
    await run(subject)
  } finally {
    vi.doUnmock(dependencyPath)
    vi.resetModules()
  }
}
