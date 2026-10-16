/**
 * @file The request schema every list endpoint shares: `search`, `sort`,
 * `cursor`, `direction`, `limit` and `total`, plus the list's own filters,
 * with the `prev` rule stated once. Its output carries the scope hash the
 * cursor is bound to, computed from the effective (defaulted) filters.
 */
import { z } from 'zod'
import { listScope } from '@/utilities/list-cursor.utilities'
import type { ListParams } from '@/utilities/list-page.utilities'

const MAX_SEARCH_LENGTH = 100
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/**
 * `search`: trimmed, 1–100 characters, no NUL.
 */
const searchField = z
  .string()
  .trim()
  .min(1, 'search must not be empty.')
  .max(MAX_SEARCH_LENGTH, `search must be at most ${MAX_SEARCH_LENGTH} characters.`)
  .refine((value) => !value.includes('\0'), 'search must not contain a NUL character.')

/**
 * `limit`: 1–100, 20 by default.
 */
const limitField = z.coerce
  .number()
  .int('limit must be a whole number.')
  .min(1, 'limit must be at least 1.')
  .max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}.`)
  .default(DEFAULT_LIMIT)

/**
 * A comma-separated enum filter (`status=active,inactive`): each value one
 * of `values`, returned sorted and deduplicated.
 * @param name - The query field's name, for its message.
 * @param values - The allowed values.
 * @returns The field; chain `.optional()` or `.default([...])`.
 */
export function listFilter<const TValues extends readonly [string, ...string[]]>(
  name: string,
  values: TValues
) {
  const allowed: ReadonlySet<string> = new Set(values)
  return z.string().transform((raw, context): TValues[number][] => {
    const parts = raw.split(',').map((part) => part.trim())
    if (parts.some((part) => !allowed.has(part))) {
      context.addIssue({
        code: 'custom',
        message: `${name} must be a comma-separated list of: ${values.join(', ')}.`,
      })
      return z.NEVER
    }
    return [...new Set(parts)].toSorted((a, b) => a.localeCompare(b))
  })
}

/**
 * A query-string boolean filter: exactly `true` or `false`.
 */
export const booleanFilter = z.enum(['true', 'false']).transform((value) => value === 'true')

/**
 * What a list schema yields: the shared params, scope included, and the list's filters.
 */
export interface ListQuery<TFilters> {
  params: ListParams
  filters: TFilters
}

/**
 * The shared params as the schema parses them, before the scope is added.
 */
interface SharedOutput {
  search?: string | undefined
  sort?: string | undefined
  cursor?: string | undefined
  direction: 'next' | 'prev'
  limit: number
  total?: '1' | undefined
}

/**
 * Build one list's query schema.
 * @param options - The list's sorts and filters.
 * @param options.sorts - Every whitelisted sort key, `-` prefixed when descending.
 * @param options.defaultSort - The sort when none is asked for, or a function of the filters choosing it.
 * @param options.filters - The list's own filter fields, defaults applied in the fields.
 * @param options.refine - Extra cross-field checks on the parsed filters.
 * @returns The schema; its output is `{ params, filters }`.
 */
export function listParamsSchema<
  const TSorts extends readonly [string, ...string[]],
  TFilters extends z.ZodRawShape,
>(options: {
  sorts: TSorts
  defaultSort: TSorts[number] | ((filters: z.output<z.ZodObject<TFilters>>) => TSorts[number])
  filters: TFilters
  refine?: (filters: z.output<z.ZodObject<TFilters>>, context: z.RefinementCtx) => void
}) {
  const shared = z.object({
    search: searchField.optional(),
    sort: z
      .enum(options.sorts, { error: `sort must be one of: ${options.sorts.join(', ')}.` })
      .optional(),
    // Any string, the empty one included: verifyCursor refuses a bad one as InvalidCursorError.
    cursor: z.string().optional(),
    direction: z
      .enum(['next', 'prev'], { error: 'direction must be next or prev.' })
      .default('next'),
    limit: limitField,
    total: z.literal('1', { error: 'total must be 1.' }).optional(),
  })
  return z
    .object({ ...shared.shape, ...options.filters })
    .superRefine((query, context) => {
      const { direction, cursor } = query as SharedOutput
      if (direction === 'prev' && cursor === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['cursor'],
          message: 'cursor is required when direction is prev.',
        })
      }
    })
    .transform((query, context): ListQuery<z.output<z.ZodObject<TFilters>>> => {
      const parsed = query as SharedOutput & Record<string, unknown>
      const values = Object.fromEntries(
        Object.keys(options.filters).map((name) => [name, parsed[name]])
      ) as z.output<z.ZodObject<TFilters>>
      options.refine?.(values, context)
      const sort =
        parsed.sort ??
        (typeof options.defaultSort === 'function'
          ? options.defaultSort(values)
          : options.defaultSort)
      return {
        params: {
          search: parsed.search,
          sort,
          cursor: parsed.cursor,
          direction: parsed.direction,
          limit: parsed.limit,
          total: parsed.total === '1',
          scope: listScope({ search: parsed.search, sort, filters: values }),
        },
        filters: values,
      }
    })
}
