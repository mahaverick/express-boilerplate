/**
 * @file Mutates a value held only in this process's memory for the life of
 * one `run` callback and restores it in a `finally`, so a test can prove a
 * security behaviour is real by breaking it without ever writing to a file
 * under `src/`. Prefer `withMutatedMethod`; reach for `withMutatedModule`
 * only when there is no shared mutable object to swap a method on.
 */
import { vi } from 'vite-plus/test'

/**
 * Replace one method on a shared object, typically `SomeClass.prototype`, for
 * the duration of `run`. The original is restored in a `finally`, so a
 * synchronous throw or a rejection from `run` still restores it.
 *
 * A plain property assignment, not `vi.spyOn`: there is no mock state to
 * reconcile with the vitest config, which sets neither `restoreMocks` nor
 * `mockReset`, and no typing of a generic method key to fight. A caller that wants call tracking passes `vi.fn(implementation)`
 * and reads its `.mock.calls`.
 * @param target - The object carrying the method, typically an exported class's `.prototype`.
 * @param methodName - The method to replace.
 * @param implementation - The stand-in to install.
 * @param run - The test logic to execute while the mutation is active.
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
 * Replace some of a module's named exports for the duration of `run`. The
 * real module is restored in a `finally`, so a synchronous throw or a
 * rejection from `run` still restores it. Use it only when
 * `withMutatedMethod` does not apply: a function captured by value at another
 * module's load time (e.g. a key generator `createRateLimiter` in
 * rate-limit.middleware.ts hands to express-rate-limit as `keyGenerator`) has
 * no shared mutable object a property assignment can reach.
 *
 * `loadSubject` must be a thunk whose body is a literal `import('...')` written
 * at the call site, such as `() => import('@/services/session.service')`,
 * never a path built from a variable. A literal specifier lets the bundler
 * resolve the `@/` alias and lets `TSubject` be inferred without a cast. The
 * thunk runs after the mutation is installed and the module cache is cleared,
 * so the subject's own imports resolve to the mutated dependency.
 *
 * Not free: `vi.resetModules()` discards this worker's whole module cache, so
 * `loadSubject` re-evaluates every module between it and the mutated
 * dependency, including ones with side effects at module scope.
 * `database.service.ts` opens a fresh postgres pool (`DB_POOL_MAX`) each time
 * it is re-evaluated and nothing closes the previous one. That is fine for the
 * few calls a mutation proof needs; do not call this in a loop.
 * @param dependencyPath - The dependency's module specifier, exactly as `src/` imports it (e.g. `@/repositories/user-token.repository`).
 * @param overrides - Replacement values, merged over the dependency's real exports.
 * @param loadSubject - Loads the module under test, as a literal `import()` thunk.
 * @param run - The test logic to execute against the freshly loaded subject while the mutation is active.
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
