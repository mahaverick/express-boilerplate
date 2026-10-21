/**
 * @file parseBody's own behaviour needs no database, so this lives under
 * tests/unit/, not tests/integration/. The `.strict()` schema below is defined
 * only for this test: its unknown-key rejection is a root-level issue with no
 * field to attach to, which parseBody must surface. The last block pins the
 * copy zod's own messages are replaced with, so a schema that sets no message
 * still answers a person in plain words.
 */
import { describe, expect, it } from 'vite-plus/test'
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

  it('answers a failed parse with a message that names the next step', () => {
    const error = captureRejection(z.object({ name: z.string() }), {})

    expect(error.message).toBe('Check the highlighted fields, then try again.')
  })
})

describe("zod's default messages", () => {
  /**
   * The field messages a parse answers for one field and one input.
   */
  function fieldMessages(field: z.ZodType, input: unknown): string[] | undefined {
    const errors = captureRejection(z.object({ field }), { field: input }).errors as Record<
      string,
      string[]
    >
    return errors.field
  }

  it.each([
    ['a missing value', z.string(), undefined, 'Enter a value.'],
    ['text where a number goes', z.number(), 'ten', 'Enter a number.'],
    ['a number where text goes', z.string(), 10, 'Enter text.'],
    ['a value where true or false goes', z.boolean(), 'yes', 'Choose true or false.'],
    ['a value where a list goes', z.array(z.string()), 'a', 'Enter a list.'],
    ['an address with no @', z.email(), 'ada', 'Enter an email address, such as ada@example.com.'],
    ['a malformed id', z.uuid(), 'abc', 'Enter a 36-character ID.'],
    [
      'a malformed web address',
      z.url(),
      'not a url',
      'Enter a web address that starts with https://.',
    ],
    [
      'a malformed date and time',
      z.iso.datetime(),
      'soon',
      'Enter a date and time, such as 2026-10-20T15:42:00Z.',
    ],
    [
      'text that misses a pattern',
      z.string().regex(/^a+$/),
      'b',
      'Check the format of this value, then try again.',
    ],
    ['text one character short', z.string().min(3), 'ab', 'Enter at least 3 characters.'],
    ['text one character long', z.string().max(2), 'abc', 'Enter 2 characters or fewer.'],
    ['an empty required text', z.string().min(1), '', 'Enter a value.'],
    ['a list too short', z.array(z.string()).min(2), ['a'], 'Add at least 2 items.'],
    ['a list too long', z.array(z.string()).max(1), ['a', 'b'], 'Use 1 item or fewer.'],
    ['a number too small', z.number().min(5), 4, 'Enter 5 or more.'],
    ['a number too big', z.number().max(5), 6, 'Enter 5 or less.'],
    ['a fraction where a whole number goes', z.number().int(), 1.5, 'Enter a whole number.'],
    ['a value outside a choice', z.enum(['a', 'b']), 'c', 'Choose one of: a, b.'],
  ])('answers %s in plain words', (_case, field, input, expected) => {
    expect(fieldMessages(field, input)).toEqual([expected])
  })

  it('names each key a strict schema refuses', () => {
    const error = captureRejection(z.object({ name: z.string() }).strict(), {
      name: 'Ada',
      extra: 1,
    })

    expect((error.errors as { formErrors?: string[] }).formErrors).toEqual([
      'Remove the field this request does not accept: extra.',
    ])
  })

  it('keeps a message a schema sets itself', () => {
    expect(fieldMessages(z.string().min(1, 'Name is required.'), '')).toEqual(['Name is required.'])
  })
})
