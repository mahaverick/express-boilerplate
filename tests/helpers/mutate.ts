/**
 * @file Mutates a value held only in this process's memory for the life of
 * one `run` callback and restores it in a `finally`, so a test can prove a
 * security behaviour is real by breaking it without ever writing to a file
 * under `src/`. Prefer `withMutatedMethod`; reach for `withMutatedModule`
 * only when there is no shared mutable object to swap a method on.
 */
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
 * synchronously or its returned promise rejects. Use this only when
 * `withMutatedMethod` does not apply — a plain function captured by value at
 * another module's load time (e.g. `loginRateLimitKey`, passed as
 * `keyGenerator` inside a factory in rate-limit.middleware.ts) has no shared
 * mutable object a property assignment can reach.
 *
 * `loadSubject` must be a thunk whose body is a literal `import('...')`
 * expression written at the CALL SITE — `() =>
 * import('@/services/session.service')`, never a path built from a
 * variable and handed to this function as a string. A literal import
 * specifier is what lets the bundler resolve this project's `@/` alias and
 * infer `TSubject` without an unsafe cast; this function only calls the
 * thunk, after the mutation is installed and the module cache is cleared,
 * so the subject's own imports resolve to the mutated dependency.
 *
 * Not free: `vi.resetModules()` discards this worker's entire module cache,
 * so `loadSubject` re-evaluates every module between it and the mutated
 * dependency, including ones with real side effects at module scope —
 * `database.service.ts` opens a fresh postgres connection pool (`DB_POOL_MAX`)
 * every time it is re-evaluated, and nothing closes the previous one.
 * Acceptable for the handful of calls a mutation proof needs; do not call
 * this in a loop or from a test that runs often.
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
