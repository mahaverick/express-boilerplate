/**
 * @file The shared list query schema: the shared fields' bounds and
 * messages, the `prev` rule, comma-list filters, defaults, and a scope that
 * is the same for the same view however the URL spells it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { booleanFilter, listFilter, listParamsSchema } from '@/validators/list.validators'

const schema = listParamsSchema({
  sorts: ['email', 'created', '-created'],
  defaultSort: 'email',
  filters: {
    status: listFilter('status', ['active', 'inactive', 'deleted']).default(['active', 'inactive']),
    staff: booleanFilter.optional(),
    user: z.uuid('user must be a 36-character user ID.').optional(),
  },
})

/**
 * The field errors of a refused query.
 */
function errorsOf(query: Record<string, string>): Record<string, string[] | undefined> {
  const result = schema.safeParse(query)
  if (result.success) throw new Error('expected a refusal')
  return z.flattenError(result.error).fieldErrors
}

describe('listParamsSchema', () => {
  it('applies every default and binds them into the scope', () => {
    const { params, filters } = schema.parse({})
    expect(params).toMatchObject({
      search: undefined,
      sort: 'email',
      cursor: undefined,
      direction: 'next',
      limit: 20,
      total: false,
    })
    expect(filters).toEqual({ status: ['active', 'inactive'], staff: undefined, user: undefined })
  })

  it('gives an omitted default and the same value sent explicitly one scope', () => {
    const omitted = schema.parse({}).params.scope
    expect(schema.parse({ status: 'inactive,active' }).params.scope).toBe(omitted)
    expect(schema.parse({ status: 'active,inactive,active', sort: 'email' }).params.scope).toBe(
      omitted
    )
  })

  it('gives another sort, search or filter another scope', () => {
    const omitted = schema.parse({}).params.scope
    expect(schema.parse({ sort: 'created' }).params.scope).not.toBe(omitted)
    expect(schema.parse({ search: 'ann' }).params.scope).not.toBe(omitted)
    expect(schema.parse({ status: 'deleted' }).params.scope).not.toBe(omitted)
    expect(schema.parse({ staff: 'true' }).params.scope).not.toBe(omitted)
  })

  it('leaves limit and direction out of the scope', () => {
    expect(schema.parse({ limit: '50' }).params.scope).toBe(schema.parse({}).params.scope)
  })

  it('trims search and refuses an empty, overlong or NUL search', () => {
    expect(schema.parse({ search: '  ann  ' }).params.search).toBe('ann')
    expect(errorsOf({ search: ' '.repeat(3) }).search).toEqual(['search must not be empty.'])
    expect(errorsOf({ search: 'a'.repeat(101) }).search).toEqual([
      'search must be at most 100 characters.',
    ])
    expect(errorsOf({ search: 'a\0b' }).search).toEqual([
      'search must not contain a null character (U+0000).',
    ])
  })

  it('refuses an unknown sort, naming the whitelist', () => {
    expect(errorsOf({ sort: '-email' }).sort).toEqual([
      'sort must be one of: email, created, -created.',
    ])
  })

  it('refuses prev without a cursor', () => {
    expect(errorsOf({ direction: 'prev' }).cursor).toEqual([
      'cursor is required when direction is prev.',
    ])
  })

  it('passes an empty cursor through, for verifyCursor to refuse with the cursor error', () => {
    expect(schema.parse({ cursor: '' }).params.cursor).toBe('')
  })

  it('passes an oversize cursor through too, so the one signed-cursor path refuses it', () => {
    expect(schema.parse({ cursor: 'x'.repeat(5000) }).params.cursor).toHaveLength(5000)
  })

  it('bounds limit to 1–100', () => {
    expect(errorsOf({ limit: '0' }).limit).toEqual(['limit must be at least 1 row.'])
    expect(errorsOf({ limit: '101' }).limit).toEqual(['limit must be at most 100 rows.'])
    expect(schema.parse({ limit: '100' }).params.limit).toBe(100)
  })

  it('takes total=1 only', () => {
    expect(schema.parse({ total: '1' }).params.total).toBe(true)
    expect(errorsOf({ total: 'yes' }).total).toEqual(['total must be 1.'])
  })

  it('refuses an unknown value in a comma list, naming the allowed ones', () => {
    expect(errorsOf({ status: 'active,banned' }).status).toEqual([
      'status must be a comma-separated list of: active, inactive, deleted.',
    ])
  })

  it('chooses the default sort from the filters when given a function', () => {
    const onboarding = listParamsSchema({
      sorts: ['progress', '-started', 'name'],
      defaultSort: (filters) => (filters.state === 'stuck' ? 'progress' : '-started'),
      filters: { state: z.enum(['stuck', 'complete']).default('stuck') },
    })
    expect(onboarding.parse({}).params.sort).toBe('progress')
    expect(onboarding.parse({ state: 'complete' }).params.sort).toBe('-started')
  })

  it('runs the refine hook on the parsed filters', () => {
    const ranged = listParamsSchema({
      sorts: ['-created'],
      defaultSort: '-created',
      filters: { from: z.string().optional(), to: z.string().optional() },
      refine: (filters, context) => {
        if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
          context.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from.' })
        }
      },
    })
    const result = ranged.safeParse({ from: '2026-02-01', to: '2026-01-01' })
    expect(result.success).toBe(false)
  })
})
