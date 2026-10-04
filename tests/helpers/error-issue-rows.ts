/**
 * @file PostHog Errors-query result rows for tests, built by name so a test
 * reads like the issue it seeds, and signed as the reporter signs a server
 * `$exception` when a test needs a verified row. Positions follow
 * `ERRORS_SELECT_COLUMNS`.
 */
import { signAnalyticsEvent } from '@/services/analytics/analytics-signature.service'
import { ERRORS_SELECT_COLUMNS } from '@/services/analytics/errors-query.service'

// eslint-disable-next-line unicorn/no-null -- PostHog's JSON null for an absent property
const ABSENT = null

/**
 * One seeded issue: its group columns and its most recent event's columns.
 */
export interface SeededIssue {
  issueId: string
  count: number
  firstSeen: string
  lastSeen: string
  uuid: string
  distinctId: string
  exceptionList: unknown
  app?: string | undefined
  source?: string | undefined
  tenant?: string | undefined
  signature?: string | undefined
}

/**
 * A result row in `ERRORS_SELECT_COLUMNS` order; an unset property is
 * `null`, as PostHog answers for an absent one.
 * @param issue - The seeded issue.
 * @returns The positional row.
 */
export function issueRow(issue: SeededIssue): unknown[] {
  return [
    issue.issueId,
    issue.count,
    issue.firstSeen,
    issue.lastSeen,
    issue.uuid,
    issue.distinctId,
    typeof issue.exceptionList === 'string'
      ? issue.exceptionList
      : JSON.stringify(issue.exceptionList),
    issue.app ?? ABSENT,
    issue.source ?? ABSENT,
    ABSENT,
    ABSENT,
    ABSENT,
    issue.tenant ?? ABSENT,
    issue.signature ?? ABSENT,
  ]
}

/**
 * A HogQL answer body holding these issues, in order.
 * @param issues - The issues.
 * @returns `{ columns, results }`.
 */
export function issuesAnswer(issues: readonly SeededIssue[]): {
  columns: readonly string[]
  results: unknown[][]
} {
  return { columns: ERRORS_SELECT_COLUMNS, results: issues.map((issue) => issueRow(issue)) }
}

/**
 * The issue with `signature` set to this server's signature over its most
 * recent event, as the reporter signs a server `$exception`.
 * @param issue - The seeded issue.
 * @returns The signed issue.
 */
export function signedIssue(issue: SeededIssue): SeededIssue {
  return {
    ...issue,
    signature: signAnalyticsEvent({
      uuid: issue.uuid,
      event: '$exception',
      distinctId: issue.distinctId,
      source: issue.source ?? ABSENT,
      access: ABSENT,
      targetType: ABSENT,
      targetId: ABSENT,
      tenant: issue.tenant ?? ABSENT,
    }),
  }
}
