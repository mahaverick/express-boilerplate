// tests/integration/repositories/email-log.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every row this file creates is
// deleted in afterEach.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UNKNOWN_ERROR_CODE } from '@/database/models/email-log.model'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { sql } from '@/services/database.service'

const emailLogRepository = new EmailLogRepository()

/**
 * A disposable recipient address, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueRecipient(): string {
  return `email-log-repo-${randomUUID()}@example.test`
}

describe('EmailLogRepository', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from email_logs where id = any(${createdIds})`
    createdIds.length = 0
  })

  it('records a successful send', async () => {
    const recipient = uniqueRecipient()

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'sent',
      providerMessageId: 'provider-message-id-1',
    })
    createdIds.push(recorded.id)

    expect(recorded.id).toBeTruthy()
    expect(recorded.recipient).toBe(recipient)
    expect(recorded.templateKey).toBe('password_reset')
    expect(recorded.status).toBe('sent')
    expect(recorded.providerMessageId).toBe('provider-message-id-1')
    expect(recorded.errorCode).toBeNull()
    expect(recorded.createdAt).toBeInstanceOf(Date)
  })

  it('records a failed send', async () => {
    const recipient = uniqueRecipient()

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'email_verification',
      status: 'failed',
      errorCode: 'ECONNECTION',
    })
    createdIds.push(recorded.id)

    expect(recorded.status).toBe('failed')
    expect(recorded.errorCode).toBe('ECONNECTION')
    expect(recorded.providerMessageId).toBeNull()
  })

  // Round-1 fix to this task: a raw token (token.utilities.ts) hex-encoded
  // is EXACTLY 64 characters, so an earlier version of this repository —
  // which truncated an over-length errorCode to ERROR_CODE_MAX_LENGTH
  // rather than normalizing it — would have written a 32-character PREFIX
  // of a live secret into this audit table. Ruling E (task-4-brief.md)
  // still applies (a log write must never fail an already-sent email's
  // request), but the remedy for a mis-shaped value is replacement, not
  // truncation: nothing that looks like a raw token may reach the table in
  // any form, partial or whole.
  it('normalizes a raw-token-shaped error code to UNKNOWN_ERROR_CODE rather than storing any part of it', async () => {
    const recipient = uniqueRecipient()
    const rawToken = randomBytes(32).toString('hex')

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: rawToken,
    })
    createdIds.push(recorded.id)

    expect(recorded.errorCode).toBe(UNKNOWN_ERROR_CODE)

    // Read the table directly, not record()'s return value — the token
    // must not have landed on disk in any form, not even as a fragment of
    // a longer stored value.
    const [row] = await sql`select * from email_logs where id = ${recorded.id}`
    expect(row?.error_code).toBe(UNKNOWN_ERROR_CODE)
    expect(JSON.stringify(row)).not.toContain(rawToken)
  })

  // Round-2 review finding 1: the test above uses a 64-character token,
  // which fails withErrorCodeNormalized's LENGTH check alone — it never
  // exercises ERROR_CODE_PATTERN, because the length check short-circuits
  // first. Deleting the regex clause from the guard entirely still passed
  // the full suite before this test existed (see
  // email-log-error-code-shape-mutation.test.ts for the load-bearing
  // proof). This value is deliberately 32 characters — exactly
  // ERROR_CODE_MAX_LENGTH, so it passes the length check and the regex
  // clause is the ONLY thing standing between it and the database — and
  // it is also the realistic leak: a 32-character lowercase-hex fragment
  // is exactly what a truncated (or otherwise mis-derived) raw token would
  // look like.
  it('normalizes a wrong-shaped-but-within-width error code to UNKNOWN_ERROR_CODE', async () => {
    const recipient = uniqueRecipient()
    const wrongShaped = 'a1'.repeat(16) // 32 lowercase-hex characters

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: wrongShaped,
    })
    createdIds.push(recorded.id)

    expect(recorded.errorCode).toBe(UNKNOWN_ERROR_CODE)

    const [row] = await sql`select * from email_logs where id = ${recorded.id}`
    expect(row?.error_code).toBe(UNKNOWN_ERROR_CODE)
    expect(JSON.stringify(row)).not.toContain(wrongShaped)
  })

  it('findByRecipient returns every row for that recipient, ordered oldest first', async () => {
    const recipient = uniqueRecipient()

    const first = await emailLogRepository.record({
      recipient,
      templateKey: 'email_verification',
      status: 'sent',
      providerMessageId: 'first',
    })
    createdIds.push(first.id)
    const second = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: 'EENVELOPE',
    })
    createdIds.push(second.id)

    const rows = await emailLogRepository.findByRecipient(recipient)
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id])
  })

  it('findByRecipient returns an empty array for a recipient with no rows', async () => {
    expect(await emailLogRepository.findByRecipient(uniqueRecipient())).toEqual([])
  })

  // Round-2 review finding 4. The version this replaced generated a raw
  // token and a rendered body and then asserted they weren't in the table
  // — but never actually passed either to record(); `NewEmailLog` has no
  // field for a rendered body at all, so that assertion could not have
  // gone red for any real defect in this repository. This version DRIVES
  // the token through record()'s actual input, field by field, and checks
  // the table itself.
  //
  // Deliberately scoped to the two fields this schema actually guards —
  // `errorCode` (normalization) and `templateKey` (width, post round-2
  // finding 2) — not "every string field": `recipient` (MAX_EMAIL_LENGTH)
  // and `providerMessageId` (255) carry no structural protection at all,
  // confirmed empirically (a raw token passed as either lands verbatim in
  // the table — see task-4-report.md's round-2 notes) and by design —
  // this table's load-bearing property was never a claim about those two
  // columns (see email-log.model.ts's header comment, round-2 finding 3).
  // Writing this test against a claim the schema does not make would just
  // be a second version of finding 4's original defect: an assertion that
  // cannot mean what it appears to mean.
  it('never contains the raw token, driven through every field this schema actually guards', async () => {
    const rawToken = randomBytes(32).toString('hex') // 64 lowercase-hex characters

    // errorCode: guarded by normalization — the row is written, but with
    // errorCode replaced, never the token itself. Scoped to this test's
    // own row (by id), not the whole table, so a concurrently-running test
    // elsewhere can't affect this assertion.
    const errorCodeRecipient = uniqueRecipient()
    const viaErrorCode = await emailLogRepository.record({
      recipient: errorCodeRecipient,
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: rawToken,
    })
    createdIds.push(viaErrorCode.id)

    const [errorCodeRow] = await sql`select * from email_logs where id = ${viaErrorCode.id}`
    expect(JSON.stringify(errorCodeRow)).not.toContain(rawToken)

    // templateKey: guarded by width alone (32, narrower than a 64-char
    // token) — the insert itself must reject; no row can land with the
    // token as its templateKey, full stop.
    const templateKeyRecipient = uniqueRecipient()
    await expect(
      emailLogRepository.record({
        recipient: templateKeyRecipient,
        templateKey: rawToken,
        status: 'sent',
      })
    ).rejects.toThrow()

    const rowsForRejectedAttempt = await sql`
      select 1 from email_logs where recipient = ${templateKeyRecipient}
    `
    expect(rowsForRejectedAttempt).toHaveLength(0)
  })
})
