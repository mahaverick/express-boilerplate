// tests/unit/helpers/mutate.test.ts
//
// Pure unit tests for the mutation-test harness itself (tests/helpers/mutate.ts)
// — no Postgres, no Redis. The harness's proof against a REAL security
// behaviour (reuse detection, session.service.ts) lives under
// tests/integration/ instead, because that proof exercises the real
// per-worker database — see CLAUDE.md's "Git hooks and CI" section on why a
// test's dependencies, not where its assertions live, decide its directory.
//
// withMutatedModule's fixture below is a REAL, already-committed pair of
// src modules — env.config.ts imports parseDurationMs from
// duration.utilities.ts, exactly the shape a real mutation takes — rather
// than a toy pair invented for this test.
import { describe, expect, it } from 'vitest'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'

describe('withMutatedMethod', () => {
  class Greeter {
    greet(name: string): string {
      return `hello, ${name}`
    }
  }

  it('replaces the method for the duration of run, visible to any holder of the same instance', async () => {
    const target = new Greeter()

    await withMutatedMethod(
      Greeter.prototype,
      'greet',
      () => 'mutated',
      () => {
        expect(target.greet('world')).toBe('mutated')
      }
    )
  })

  it('restores the original implementation once run resolves', async () => {
    const target = new Greeter()

    await withMutatedMethod(
      Greeter.prototype,
      'greet',
      () => 'mutated',
      () => {}
    )

    expect(target.greet('world')).toBe('hello, world')
  })

  it('restores the original implementation when run throws synchronously', async () => {
    const target = new Greeter()

    await expect(
      withMutatedMethod(
        Greeter.prototype,
        'greet',
        () => 'mutated',
        () => {
          throw new Error('boom')
        }
      )
    ).rejects.toThrow('boom')

    expect(target.greet('world')).toBe('hello, world')
  })

  it('restores the original implementation when run returns a rejected promise', async () => {
    const target = new Greeter()

    await expect(
      withMutatedMethod(
        Greeter.prototype,
        'greet',
        () => 'mutated',
        async () => {
          await Promise.reject(new Error('async boom'))
        }
      )
    ).rejects.toThrow('async boom')

    expect(target.greet('world')).toBe('hello, world')
  })
})

describe('withMutatedModule', () => {
  it('swaps the dependency for a freshly-loaded subject', async () => {
    await withMutatedModule<
      typeof import('@/utilities/duration.utilities'),
      typeof import('@/configs/env.config')
    >(
      '@/utilities/duration.utilities',
      { parseDurationMs: () => {} },
      () => import('@/configs/env.config'),
      (subject) => {
        // Every *_TTL field's zod refinement calls parseDurationMs and
        // requires a defined result — forcing it to always return
        // undefined makes every one of them fail, so a real,
        // otherwise-valid environment is rejected.
        expect(() => subject.parseEnv(process.env)).toThrow(/ACCESS_TOKEN_TTL/)
      }
    )
  })

  it('restores the real dependency once run resolves, for a subsequent fresh import', async () => {
    await withMutatedModule(
      '@/utilities/duration.utilities',
      { parseDurationMs: () => {} },
      () => import('@/configs/env.config'),
      () => {}
    )

    const { parseEnv } = await import('@/configs/env.config')
    expect(() => parseEnv(process.env)).not.toThrow()
  })

  it('restores the real dependency when run throws', async () => {
    await expect(
      withMutatedModule(
        '@/utilities/duration.utilities',
        { parseDurationMs: () => {} },
        () => import('@/configs/env.config'),
        () => {
          throw new Error('boom')
        }
      )
    ).rejects.toThrow('boom')

    const { parseEnv } = await import('@/configs/env.config')
    expect(() => parseEnv(process.env)).not.toThrow()
  })
})
