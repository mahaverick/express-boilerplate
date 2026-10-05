/**
 * @file mapErrorIssues: positional rows to issues, the server signature
 * verified exactly as the signer computes it (a forged `app: 'api'` row is
 * a server row with `verified: false`), type and value scrubbed again, the
 * app allowlist, the issue link, and unusable rows dropped.
 */
import { describe, expect, it } from 'vitest'
import { mapErrorIssues } from '@/services/analytics/errors-mapper.service'
import { issueRow, signedIssue, type SeededIssue } from '../../../helpers/error-issue-rows'

const LINK_BASE = 'https://us.posthog.com/project/4321/error_tracking'
const USER_ID = '0199a1b2-0000-7000-8000-000000000001'

/**
 * A server-shaped issue for `USER_ID`, unsigned.
 * @param overrides - Any other columns.
 * @returns The seeded issue.
 */
function seeded(overrides: Partial<SeededIssue> = {}): SeededIssue {
  return {
    issueId: '01a107cd-a5be-70c3-962f-84a46f9d9e46',
    count: 3,
    firstSeen: '2026-10-01T09:00:00.000000Z',
    lastSeen: '2026-10-04T10:00:42.886001Z',
    uuid: '0199a1b2-0000-7000-8000-0000000000aa',
    distinctId: USER_ID,
    exceptionList: [{ type: 'TypeError', value: 'x is undefined' }],
    app: 'api',
    source: 'error',
    ...overrides,
  }
}

describe('mapErrorIssues', () => {
  it('maps a signed server issue as verified, with its link', () => {
    const row = issueRow(signedIssue(seeded()))

    const [issue] = mapErrorIssues([row], LINK_BASE)

    expect(issue).toEqual({
      issueId: '01a107cd-a5be-70c3-962f-84a46f9d9e46',
      type: 'TypeError',
      value: 'x is undefined',
      count: 3,
      firstSeen: '2026-10-01T09:00:00.000000Z',
      lastSeen: '2026-10-04T10:00:42.886001Z',
      source: 'server',
      app: 'api',
      verified: true,
      link: `${LINK_BASE}/01a107cd-a5be-70c3-962f-84a46f9d9e46`,
    })
  })

  it("marks a forged app: 'api' issue a server row that is not verified", () => {
    const forged = seeded({ signature: 'f'.repeat(32) })

    expect(mapErrorIssues([issueRow(forged)], LINK_BASE)[0]).toMatchObject({
      source: 'server',
      verified: false,
    })
  })

  it('does not verify a signature taken from another event', () => {
    const signed = signedIssue(seeded())
    const moved = { ...signed, uuid: '0199a1b2-0000-7000-8000-0000000000bb' }

    expect(mapErrorIssues([issueRow(moved)], LINK_BASE)[0]?.verified).toBe(false)
  })

  it('maps a browser issue, keeping a known app and dropping an unknown one', () => {
    const rows = [
      issueRow(seeded({ app: 'react', source: undefined })),
      issueRow(seeded({ app: 'evil', source: undefined })),
    ]

    expect(mapErrorIssues(rows, LINK_BASE)).toEqual([
      expect.objectContaining({ source: 'browser', app: 'react', verified: false }),
      // eslint-disable-next-line unicorn/no-null -- the contract's JSON null for an unknown app
      expect.objectContaining({ source: 'browser', app: null, verified: false }),
    ])
  })

  it('scrubs the type and value again', () => {
    const row = issueRow(
      seeded({
        exceptionList: [
          {
            type: 'Error for a@b.example',
            value: 'failed for victim@example.test with phc_abc123',
          },
        ],
      })
    )

    const [issue] = mapErrorIssues([row], LINK_BASE)

    expect(issue?.type).not.toContain('a@b.example')
    expect(issue?.value).not.toContain('victim@example.test')
    expect(issue?.value).not.toContain('phc_abc123')
  })

  it('reads an already parsed exception list, and falls back for an unreadable one', () => {
    const parsed = issueRow(seeded())
    parsed[6] = [{ type: 'RangeError', value: 'too far' }]
    const broken = issueRow(seeded({ exceptionList: '{not json' }))

    expect(mapErrorIssues([parsed, broken], LINK_BASE)).toEqual([
      expect.objectContaining({ type: 'RangeError', value: 'too far' }),
      expect.objectContaining({ type: 'Error', value: '' }),
    ])
  })

  it('reads a count sent as a numeric string', () => {
    const row = issueRow(seeded())
    row[1] = '12'

    expect(mapErrorIssues([row], LINK_BASE)[0]?.count).toBe(12)
  })

  it('links the issue by its id under the project’s Error Tracking URL', () => {
    const [issue] = mapErrorIssues([issueRow(seeded())], LINK_BASE)

    expect(issue?.link).toBe(`${LINK_BASE}/01a107cd-a5be-70c3-962f-84a46f9d9e46`)
  })

  // A forged event can set its own issue id property; only a UUID can become a link path.
  it.each([
    '..',
    '../settings',
    'a/b?c',
    '01a107cd-a5be-70c3-962f',
    '01a107cd-a5be-70c3-962f-84a46f9d9e46/..',
    ' 01a107cd-a5be-70c3-962f-84a46f9d9e46',
  ])('drops a row whose issue id %j is not UUID-shaped', (issueId) => {
    const rows = [issueRow(seeded({ issueId }))]
    expect(mapErrorIssues(rows, LINK_BASE)).toEqual([])
  })

  it('keeps an upper-case UUID issue id', () => {
    const issueId = '01A107CD-A5BE-70C3-962F-84A46F9D9E46'
    const rows = [issueRow(seeded({ issueId }))]
    expect(mapErrorIssues(rows, LINK_BASE)[0]?.issueId).toBe(issueId)
  })

  it('drops rows missing an issue id, a count, a timestamp, a uuid or a distinct id, and non-rows', () => {
    const rows: unknown[] = [
      issueRow(seeded({ issueId: '' })),
      issueRow(seeded({ count: -1 })),
      issueRow(seeded({ lastSeen: '' })),
      issueRow(seeded({ uuid: '' })),
      issueRow(seeded({ distinctId: '' })),
      'not a row',
    ]

    expect(mapErrorIssues(rows, LINK_BASE)).toEqual([])
  })
})
