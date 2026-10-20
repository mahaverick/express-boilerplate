/**
 * @file The From address a real send goes out with, read back from
 * Mailpit: the transactional sender (`MAIL_FROM_TRANSACTIONAL`, set in
 * .env.test) for a template whose link carries a token, `MAIL_FROM` for the
 * rest. Nothing a caller passes can change it.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { sendMail, type MailMessage } from '@/services/mailer.service'
import { deleteMailpitMessage, findMailpitMessages, getMailpitMessage } from '../../helpers/mailpit'

const recipients: string[] = []

afterAll(async () => {
  await sql`delete from email_logs where recipient = any(${recipients})`
})

/**
 * Returns a unique recipient address, whose `email_logs` rows are deleted in `afterAll`.
 */
function uniqueRecipient(): string {
  const address = `mailer-sender-${randomUUID()}@example.test`
  recipients.push(address)
  return address
}

/**
 * Sends one message and returns the From address Mailpit received, deleting that message from
 * Mailpit.
 */
async function fromAddressOf(message: MailMessage): Promise<string> {
  await expect(sendMail(message)).resolves.toBe('sent')
  const [received] = await findMailpitMessages(message.to)
  if (!received) throw new Error('expected the message in Mailpit')
  const detail = await getMailpitMessage(received.ID)
  await deleteMailpitMessage(received.ID)
  return detail.From.Address
}

describe('sendMail sender', () => {
  it.each([
    [
      'sign_in_link',
      {
        firstName: 'Ada',
        signInUrl: 'https://x.test/l',
        expiresInMinutes: '15',
        expiresAt: '15:42 UTC on 20 October 2026',
        appName: 'A',
        reason: 'self',
      },
    ],
    [
      'step_up_link',
      { firstName: 'Ada', confirmUrl: 'https://x.test/c', expiresInMinutes: '15', appName: 'A' },
    ],
    [
      'welcome',
      { firstName: 'Ada', signInUrl: 'https://x.test/l', expiresInMinutes: '15', appName: 'A' },
    ],
    [
      'invitation_confirm',
      {
        firstName: 'Ada',
        tenantName: 'Acme',
        role: 'editor',
        confirmUrl: 'https://x.test/c',
        expiresInMinutes: '15',
        expiresAt: '15:42 UTC on 20 October 2026',
        appName: 'A',
      },
    ],
  ] as const)(
    'sends %s, a token template, from the transactional sender',
    async (templateKey, variables) => {
      const message = { to: uniqueRecipient(), templateKey, variables } as MailMessage
      await expect(fromAddressOf(message)).resolves.toBe('auth@mail.example.test')
    },
    15_000
  )

  it('sends a token-free template from MAIL_FROM', async () => {
    const from = await fromAddressOf({
      to: uniqueRecipient(),
      templateKey: 'onboarding_reminder',
      variables: {
        tenantName: 'Acme',
        appName: 'A',
        nextStep: 'Invite a teammate',
        stepsDone: '1',
        stepsTotal: '2',
        overviewLink: 'https://example.test/tenants/acme',
      },
    })
    expect(from).toBe('no-reply@example.com')
  }, 15_000)
})
