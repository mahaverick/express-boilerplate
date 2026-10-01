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
 * A disposable recipient, tracked for cleanup.
 * @returns A unique address.
 */
function uniqueRecipient(): string {
  const address = `mailer-sender-${randomUUID()}@example.test`
  recipients.push(address)
  return address
}

/**
 * Send one message and read the From address Mailpit received.
 * @param message - The message.
 * @returns The From address.
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
    ['email_verification', { firstName: 'Ada', verificationUrl: 'https://x.test/v', appName: 'A' }],
    ['password_reset', { firstName: 'Ada', resetUrl: 'https://x.test/r', appName: 'A' }],
    ['account_setup', { firstName: 'Ada', setupUrl: 'https://x.test/s', appName: 'A' }],
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
      templateKey: 'password_changed',
      variables: { firstName: 'Ada', appName: 'A' },
    })
    expect(from).toBe('no-reply@example.com')
  }, 15_000)
})
