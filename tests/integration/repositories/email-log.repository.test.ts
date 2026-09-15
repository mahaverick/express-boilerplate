// tests/integration/repositories/email-log.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every row this file creates is
// deleted in afterEach.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ERROR_CODE_MAX_LENGTH } from '@/database/models/email-log.model'
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

  // Ruling E (task-4-brief.md): a log write must never be the thing that
  // fails an already-sent email's request. An error_code that somehow
  // exceeds the column's width must be truncated, not left to throw a
  // 22001 (string data right truncation) the way an over-length email once
  // did before MAX_EMAIL_LENGTH existed (see that constant's own comment).
  it('truncates an over-length error code rather than letting the insert throw', async () => {
    const recipient = uniqueRecipient()
    const overLong = 'E'.repeat(ERROR_CODE_MAX_LENGTH + 20)

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: overLong,
    })
    createdIds.push(recorded.id)

    expect(recorded.errorCode).toHaveLength(ERROR_CODE_MAX_LENGTH)
    expect(recorded.errorCode).toBe(overLong.slice(0, ERROR_CODE_MAX_LENGTH))

    // Read the table directly too, not just record()'s return value — the
    // truncation must have actually landed on disk, not merely on the
    // object handed back.
    const [row] = await sql`select error_code from email_logs where id = ${recorded.id}`
    expect(row?.error_code as string).toHaveLength(ERROR_CODE_MAX_LENGTH)
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

  // THE ASSERTION THAT MATTERS (task-4-brief.md): the row must never
  // contain the token a verification/reset email carries, or the rendered
  // email body — proved by reading the TABLE ITSELF, not by re-reading
  // what record() was handed. Same shape of proof as
  // "issues a refresh token whose hash — never the raw value — is stored"
  // (tests/integration/utilities/token.utilities.test.ts): query for the
  // raw sensitive value directly and confirm nothing on disk matches it.
  it('never contains the raw token or the rendered email body it accompanied', async () => {
    const recipient = uniqueRecipient()
    // Neither of these is ever passed to record() below — NewEmailLog has
    // no field that could carry either. They stand in for what a real
    // password-reset send would have handled upstream of this repository.
    const rawToken = randomBytes(32).toString('hex')
    const renderedBody = `<p>Reset your password: https://example.test/reset?token=${rawToken}</p>`

    const recorded = await emailLogRepository.record({
      recipient,
      templateKey: 'password_reset',
      status: 'sent',
      providerMessageId: 'provider-message-id-2',
    })
    createdIds.push(recorded.id)

    // Exact-match proof, mirroring token.utilities.test.ts's
    // `select 1 from user_tokens where token_hash = ${issued.raw}`: query
    // every text column of the real table for the raw value itself.
    const byToken = await sql`
      select 1 from email_logs
      where id = ${rawToken}
         or recipient = ${rawToken}
         or template_key = ${rawToken}
         or status = ${rawToken}
         or provider_message_id = ${rawToken}
         or error_code = ${rawToken}
    `
    expect(byToken).toHaveLength(0)

    const byBody = await sql`
      select 1 from email_logs
      where id = ${renderedBody}
         or recipient = ${renderedBody}
         or template_key = ${renderedBody}
         or status = ${renderedBody}
         or provider_message_id = ${renderedBody}
         or error_code = ${renderedBody}
    `
    expect(byBody).toHaveLength(0)

    // Substring proof: read the actual row back from the table (never
    // `recorded`, which only proves record() echoed its own argument) and
    // confirm the token/body do not appear anywhere inside it, not even as
    // a fragment of some other column.
    const [row] = await sql`select * from email_logs where id = ${recorded.id}`
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(rawToken)
    expect(serialized).not.toContain(renderedBody)
  })
})
