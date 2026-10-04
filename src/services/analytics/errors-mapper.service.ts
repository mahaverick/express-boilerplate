/**
 * @file PostHog Errors-query rows to error issues, read by position
 * (`ERRORS_SELECT_COLUMNS`). No value is trusted: a column of the wrong type
 * reads as absent, and a row without an issue id, a count, both timestamps,
 * a uuid or a distinct id is dropped. Anyone with the public project key can
 * send a `$exception`, so the most recent event's `server_sig` is verified
 * here, by the one rule the signer uses (`signedFieldsOf`), never in HogQL;
 * and its type and message are scrubbed again, since a forged event can
 * carry anything.
 */
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import { scrubText } from '@/services/errors/error-scrubber.service'
import type { ErrorIssue } from '@/types/error-issue'

const APPS: ReadonlySet<string> = new Set(['api', 'react', 'apex'])

/**
 * The columns' positions in a result row.
 */
const COLUMN = {
  issueId: 0,
  count: 1,
  firstSeen: 2,
  lastSeen: 3,
  uuid: 4,
  distinctId: 5,
  exceptionList: 6,
  app: 7,
  source: 8,
  access: 9,
  targetType: 10,
  targetId: 11,
  tenant: 12,
  signature: 13,
} as const

/**
 * A column as a non-empty string; PostHog reads an absent property as `''` or null.
 * @param value - The column's value.
 * @returns The string, or undefined.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A count column as a non-negative integer; ClickHouse may send a large
 * count as a numeric string.
 * @param value - The column's value.
 * @returns The count, or undefined.
 */
function countOf(value: unknown): number | undefined {
  const count = typeof value === 'string' ? Number(value) : value
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

/**
 * The first exception of a `$exception_list`, which HogQL returns as JSON
 * text (or, defensively, as the parsed array).
 * @param value - The column's value.
 * @returns Its type and value, each a string or undefined.
 */
function firstException(value: unknown): { type?: unknown; value?: unknown } {
  let list: unknown = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      return {}
    }
  }
  const [first] = Array.isArray(list) ? (list as unknown[]) : []
  return typeof first === 'object' && first !== null ? first : {}
}

/**
 * Whether the most recent event's signature verifies over its raw columns.
 * @param row - The result row.
 * @param identity - Its uuid and distinct id, already read.
 * @param identity.uuid - The uuid.
 * @param identity.distinctId - The distinct id.
 * @returns True for a server-signed event.
 */
function isSigned(
  row: readonly unknown[],
  identity: { uuid: string; distinctId: string }
): boolean {
  // The raw columns as the properties the signer read, so both sides use one rule.
  const properties = {
    source: row[COLUMN.source],
    access: row[COLUMN.access],
    target_type: row[COLUMN.targetType],
    target_id: row[COLUMN.targetId],
    $groups: { tenant: row[COLUMN.tenant] },
  }
  return isAnalyticsSignatureValid(
    signedFieldsOf({ ...identity, event: '$exception' }, properties),
    row[COLUMN.signature]
  )
}

/**
 * One result row as an error issue.
 * @param row - The result row.
 * @param issueLinkBase - The project's Error Tracking URL, without a trailing slash.
 * @returns The issue, or undefined when a required column is missing.
 */
function mapRow(row: readonly unknown[], issueLinkBase: string): ErrorIssue | undefined {
  const issueId = text(row[COLUMN.issueId])
  const count = countOf(row[COLUMN.count])
  const firstSeen = text(row[COLUMN.firstSeen])
  const lastSeen = text(row[COLUMN.lastSeen])
  const uuid = text(row[COLUMN.uuid])
  const distinctId = text(row[COLUMN.distinctId])
  if (
    issueId === undefined ||
    count === undefined ||
    firstSeen === undefined ||
    lastSeen === undefined ||
    uuid === undefined ||
    distinctId === undefined
  ) {
    return undefined
  }
  const exception = firstException(row[COLUMN.exceptionList])
  const app = text(row[COLUMN.app])
  return {
    issueId,
    type: scrubText(text(exception.type) ?? 'Error'),
    value: scrubText(text(exception.value) ?? ''),
    count,
    firstSeen,
    lastSeen,
    source: app === 'api' ? 'server' : 'browser',
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for an unknown app
    app: app !== undefined && APPS.has(app) ? app : null,
    verified: isSigned(row, { uuid, distinctId }),
    link: `${issueLinkBase}/${encodeURIComponent(issueId)}`,
  }
}

/**
 * Map a HogQL `results` array to error issues, in order, dropping anything
 * that is not a usable row.
 * @param results - The `results` of an Errors query.
 * @param issueLinkBase - The project's Error Tracking URL, `{app}/project/{pid}/error_tracking`.
 * @returns The issues.
 */
export function mapErrorIssues(results: readonly unknown[], issueLinkBase: string): ErrorIssue[] {
  const issues: ErrorIssue[] = []
  for (const result of results) {
    if (!Array.isArray(result)) continue
    const issue = mapRow(result as readonly unknown[], issueLinkBase)
    if (issue !== undefined) issues.push(issue)
  }
  return issues
}
