// tests/unit/validators/auth.validators.test.ts
//
// parseBody's own behaviour needs no database — this lives under
// tests/unit/, not tests/integration/ (see CLAUDE.md on why a DB-dependent
// test must never live under tests/unit/; this one simply isn't one).
//
// The `.strict()` schema below is throwaway, defined only for this test. No
// production schema in this codebase uses `.strict()` — see
// profile.validators.ts's header comment for why a plain allow-list was
// chosen there instead — but the option must actually work for whoever
// reaches for it next, which is exactly what this test proves.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpError } from '@/middlewares/error.middleware'
import { parseBody } from '@/validators/auth.validators'

/**
 * Call `parseBody` and capture the `HttpError` it throws, rather than
 * asserting inside a `try`/`catch` at every call site.
 * @param schema - The schema to validate against.
 * @param input - The raw, untrusted request body.
 * @returns The thrown `HttpError`.
 */
function captureRejection(schema: z.ZodType, input: unknown): HttpError {
  try {
    parseBody(schema, input)
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('parseBody did not throw for invalid input')
}

describe('parseBody', () => {
  it('still surfaces per-field errors under their own key, unchanged', () => {
    const schema = z.object({ name: z.string().min(1, 'Name is required.') })

    const error = captureRejection(schema, { name: '' })

    expect(error.statusCode).toBe(400)
    const errors = error.errors as Record<string, string[]>
    expect(errors.name).toEqual(['Name is required.'])
    // No schema-level issue exists here — the additive key must not appear
    // when there is nothing for it to carry.
    expect(errors.formErrors).toBeUndefined()
  })

  it('surfaces a schema-level rejection (formErrors) instead of silently dropping it', () => {
    const strictSchema = z.object({ name: z.string() }).strict()

    const error = captureRejection(strictSchema, { name: 'Ada', extra: 'not allowed' })

    expect(error.statusCode).toBe(400)
    // Before this fix, this schema's only issue is a root-level one with no
    // field to attach to, and parseBody discarded it entirely — the client
    // would have received `errors: {}`, indistinguishable from a validator
    // bug. This is the property that must not regress: a `.strict()`
    // rejection is client-visible, and names the offending key.
    const errors = error.errors as { formErrors?: string[] }
    expect(errors.formErrors).toBeDefined()
    expect(errors.formErrors?.length).toBeGreaterThan(0)
    expect(errors.formErrors?.join(' ')).toMatch(/extra/i)
  })
})
