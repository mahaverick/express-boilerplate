/**
 * @file PostHog result rows to timeline rows, through a fixed allowlist.
 * Each result row is read by position (`TIMELINE_SELECT_COLUMNS`), and no
 * value is trusted: a column of the wrong type reads as absent, and only the
 * `TIMELINE_PROP_KEYS` properties with a string, number or boolean value
 * reach `props`. Nothing else PostHog holds leaves the server.
 *
 * Anyone with the public project key can send PostHog an event, so the
 * server fields are trusted only on a row whose signature verifies. In this
 * order: each raw row is verified; an unverified row that could only have
 * matched through its target is dropped; every other unverified row is
 * demoted (`source: 'browser'`, `access: null`, no `target_*` props); then
 * rows are deduped by uuid, a verified copy winning.
 */
import type { AuditAccess } from '@/constants/audit.constants'
import { TIMELINE_ELEMENT_TEXT_MAX, TIMELINE_PROP_KEYS } from '@/constants/timeline.constants'
import { isAnalyticsSignatureValid } from '@/services/analytics/analytics-signature.service'
import type {
  TimelineApp,
  TimelineCursor,
  TimelineKind,
  TimelineRow,
  TimelineRowProperties,
  TimelineSource,
} from '@/types/timeline'

const SERVER_SOURCES: ReadonlySet<string> = new Set(['audit', 'product', 'email'])
const ACCESS_KINDS: ReadonlySet<string> = new Set(['member', 'platform', 'system'])
const APPS: ReadonlySet<string> = new Set(['api', 'react', 'apex'])
/**
 * The props the signature covers: kept only as the non-empty strings it read.
 */
const SIGNED_TEXT_PROPS: ReadonlySet<string> = new Set(['target_type', 'target_id'])
const CLICK_EVENTS: ReadonlySet<string> = new Set(['$autocapture', '$rageclick'])

/**
 * The fixed columns' positions in a result row; the props follow them, then
 * the tenant group and the signature.
 */
const COLUMN = {
  uuid: 0,
  event: 1,
  timestamp: 2,
  distinctId: 3,
  sessionId: 4,
  traceId: 5,
  source: 6,
  access: 7,
  app: 8,
  currentUrl: 9,
  elementText: 10,
} as const

const FIRST_PROP_COLUMN = 11
const TENANT_COLUMN = FIRST_PROP_COLUMN + TIMELINE_PROP_KEYS.length
const SIGNATURE_COLUMN = TENANT_COLUMN + 1

/**
 * Whose timeline the rows are for: the drop rule needs the target.
 */
export interface TimelineMapTarget {
  kind: TimelineKind
  id: string
}

/**
 * A column as a non-empty string. PostHog reads an absent materialized
 * property as `''`, so an empty string counts as absent.
 * @param value - The column's value.
 * @returns The string, or undefined.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A column as the signature reads it: the string, or null when absent.
 * @param value - The column's value.
 * @returns The string or null.
 */
function signedText(value: unknown): string | null {
  return text(value) ?? null // eslint-disable-line unicorn/no-null -- the signer's "absent"
}

/**
 * The pathname of a page URL, with no query and no fragment.
 * @param value - The `$current_url` column.
 * @returns The pathname, or null when the value is not an http(s) URL.
 */
function pathOf(value: unknown): string | null {
  const url = text(value)
  if (url === undefined) return null // eslint-disable-line unicorn/no-null -- the row's JSON null
  try {
    const parsed = new URL(url)
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.pathname : null
  } catch {
    return null // eslint-disable-line unicorn/no-null -- the row's JSON null
  }
}

/**
 * The clicked element's text, cut to `TIMELINE_ELEMENT_TEXT_MAX` characters
 * (code points, so no surrogate pair is split), on a click event only.
 * @param event - The event name.
 * @param value - The `$el_text` column.
 * @returns The text, or null.
 */
function elementTextOf(event: string, value: unknown): string | null {
  const elementText = text(value)
  // eslint-disable-next-line unicorn/no-null -- the row's JSON null
  if (elementText === undefined || !CLICK_EVENTS.has(event)) return null
  return [...elementText].slice(0, TIMELINE_ELEMENT_TEXT_MAX).join('')
}

/**
 * The allowlisted properties of one result row that hold a string, number
 * or boolean; an empty string counts as absent.
 * @param row - The result row.
 * @returns The props.
 */
function propertiesOf(row: readonly unknown[]): TimelineRowProperties {
  const properties: TimelineRowProperties = {}
  for (const [offset, key] of TIMELINE_PROP_KEYS.entries()) {
    const value = row[FIRST_PROP_COLUMN + offset]
    if (SIGNED_TEXT_PROPS.has(key)) {
      // The signature covers these as non-empty strings only, so nothing else may reach a verified row.
      const signed = text(value)
      if (signed !== undefined) properties[key] = signed
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      text(value) !== undefined
    ) {
      properties[key] = value as string | number | boolean
    }
  }
  return properties
}

/**
 * A column as one of a fixed set of strings.
 * @param value - The column's value.
 * @param allowed - The strings it may be.
 * @returns The value, or undefined when it is not one of them.
 */
function oneOf(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  const candidate = text(value)
  return candidate !== undefined && allowed.has(candidate) ? candidate : undefined
}

/**
 * Whether a raw row's signature verifies over its raw columns.
 * @param row - The result row.
 * @param identity - Its uuid, event and distinct id, already read.
 * @param identity.uuid - The uuid.
 * @param identity.event - The event name.
 * @param identity.distinctId - The distinct id.
 * @returns True for a server-signed row.
 */
function isSigned(
  row: readonly unknown[],
  identity: { uuid: string; event: string; distinctId: string }
): boolean {
  const targetType = FIRST_PROP_COLUMN + TIMELINE_PROP_KEYS.indexOf('target_type')
  const targetId = FIRST_PROP_COLUMN + TIMELINE_PROP_KEYS.indexOf('target_id')
  return isAnalyticsSignatureValid(
    {
      ...identity,
      source: signedText(row[COLUMN.source]),
      access: signedText(row[COLUMN.access]),
      targetType: signedText(row[targetType]),
      targetId: signedText(row[targetId]),
      tenant: signedText(row[TENANT_COLUMN]),
    },
    row[SIGNATURE_COLUMN]
  )
}

/**
 * Whether an unverified row could have matched the query only through its
 * target, so a forger chose it: one naming the user but sent by another
 * distinct id, or one naming the tenant but outside its group.
 * @param row - The mapped row, before demotion.
 * @param target - Whose timeline.
 * @returns True when the row must be dropped.
 */
function isForgedTargetMatch(row: TimelineRow, target: TimelineMapTarget): boolean {
  if (row.props.target_type !== target.kind || row.props.target_id !== target.id) return false
  return (target.kind === 'user' ? row.distinctId : row.tenant) !== target.id
}

/**
 * An unverified row with its server fields taken away.
 * @param row - The mapped row.
 * @returns The row as a browser event, with no target props.
 */
function demoted(row: TimelineRow): TimelineRow {
  const properties = { ...row.props }
  delete properties.target_type
  delete properties.target_id
  // eslint-disable-next-line unicorn/no-null -- the row's JSON null
  return { ...row, source: 'browser', access: null, props: properties }
}

/**
 * One result row as a timeline row, verified but not yet demoted.
 * @param row - The result row.
 * @returns The row, or undefined when its uuid, event, timestamp or distinct id is missing.
 */
function mapRow(row: readonly unknown[]): TimelineRow | undefined {
  const uuid = text(row[COLUMN.uuid])
  const event = text(row[COLUMN.event])
  const timestamp = text(row[COLUMN.timestamp])
  const distinctId = text(row[COLUMN.distinctId])
  if (
    uuid === undefined ||
    event === undefined ||
    timestamp === undefined ||
    distinctId === undefined
  ) {
    return undefined
  }
  return {
    uuid,
    event,
    timestamp,
    distinctId,
    source: (oneOf(row[COLUMN.source], SERVER_SOURCES) ?? 'browser') as TimelineSource,
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    access: (oneOf(row[COLUMN.access], ACCESS_KINDS) ?? null) as AuditAccess | null,
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    app: (oneOf(row[COLUMN.app], APPS) ?? null) as TimelineApp | null,
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    sessionId: text(row[COLUMN.sessionId]) ?? null,
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    traceId: text(row[COLUMN.traceId]) ?? null,
    path: pathOf(row[COLUMN.currentUrl]),
    elementText: elementTextOf(event, row[COLUMN.elementText]),
    props: propertiesOf(row),
    verified: isSigned(row, { uuid, event, distinctId }),
    // eslint-disable-next-line unicorn/no-null -- the row's JSON null
    tenant: text(row[TENANT_COLUMN]) ?? null,
  }
}

/**
 * Map a HogQL `results` array to timeline rows: verify, drop forged target
 * matches, demote the other unverified rows, then keep one row per uuid (the
 * first, or a later verified copy of an unverified first), in order. Anything
 * that is not a usable row is dropped.
 * @param results - The `results` of a timeline query, in its order.
 * @param target - Whose timeline the query read.
 * @returns The rows.
 */
export function mapTimelineResults(
  results: readonly unknown[],
  target: TimelineMapTarget
): TimelineRow[] {
  const rows: TimelineRow[] = []
  const indexByUuid = new Map<string, number>()
  for (const result of results) {
    if (!Array.isArray(result)) continue
    const row = mapRow(result)
    if (row === undefined) continue
    if (!row.verified && isForgedTargetMatch(row, target)) continue
    const mapped = row.verified ? row : demoted(row)
    const index = indexByUuid.get(mapped.uuid)
    if (index === undefined) {
      indexByUuid.set(mapped.uuid, rows.length)
      rows.push(mapped)
    } else if (mapped.verified && rows[index]?.verified === false) {
      rows[index] = mapped
    }
  }
  return rows
}

/**
 * The cursor after a raw result row: its timestamp string and uuid, read
 * before any drop or dedupe so filtering never moves a page boundary.
 * @param result - A raw result row.
 * @returns The cursor, or undefined when the row has no timestamp or uuid.
 */
export function cursorAfter(result: unknown): TimelineCursor | undefined {
  if (!Array.isArray(result)) return undefined
  const row = result as readonly unknown[]
  const u = text(row[COLUMN.uuid])
  const t = text(row[COLUMN.timestamp])
  return u === undefined || t === undefined ? undefined : { t, u }
}
