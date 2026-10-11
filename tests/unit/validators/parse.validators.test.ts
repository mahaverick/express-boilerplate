/**
 * @file parseBody's own behaviour needs no database, so this lives under
 * tests/unit/, not tests/integration/. The `.strict()` schema below is defined
 * only for this test: its unknown-key rejection is a root-level issue with no
 * field to attach to, which parseBody must surface.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpError } from '@/errors/http-error'
import { parseBody } from '@/validators/parse.validators'

/**
 * Calls `parseBody` and returns the `HttpError` it throws, rather than
 * asserting inside a `try`/`catch` at every call site. Throws when `parseBody`
 * does not.
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
    // No schema-level issue exists here — the additive key must not appear when there is nothing for it to carry.
    expect(errors.formErrors).toBeUndefined()
  })

  it('surfaces a schema-level rejection (formErrors) instead of silently dropping it', () => {
    const strictSchema = z.object({ name: z.string() }).strict()

    const error = captureRejection(strictSchema, { name: 'Ada', extra: 'not allowed' })

    expect(error.statusCode).toBe(400)
    /**
     * A `.strict()` schema's only issue here is a root-level one with no
     * field to attach to. If parseBody discarded it, the client would
     * receive `errors: {}`, indistinguishable from a validator bug. This
     * is the property that must not regress: a `.strict()` rejection is
     * client-visible, and names the offending key.
     */
    const errors = error.errors as { formErrors?: string[] }
    expect(errors.formErrors).toBeDefined()
    expect(errors.formErrors?.length).toBeGreaterThan(0)
    expect(errors.formErrors?.join(' ')).toMatch(/extra/i)
  })
})
