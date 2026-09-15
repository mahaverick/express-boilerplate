// tests/helpers/mailpit.ts
//
// Mailpit's own HTTP API, shared by every test that asserts on outbound
// mail. `findMailpitMessages`, `assertNoMailpitMessage` and
// `deleteMailpitMessage` began as module-scope helpers inside
// mailer.service.test.ts and were moved here unchanged when a second test
// file needed them — their comments are original to that file.
// `getMailpitMessage` and `drainMailpit` are new: the former replaces an
// inline fetch that had no comment to move, the latter has no caller yet.
import { expect } from 'vitest'

const MAILPIT_API = 'http://localhost:8025/api/v1'

export interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

export interface MailpitMessageDetail {
  HTML: string
  Text: string
}

/**
 * Poll Mailpit's own HTTP API for messages to one recipient, retrying
 * briefly — a real SMTP delivery is not synchronous with Mailpit's search
 * index becoming queryable.
 * @param recipient - The `To:` address to search for.
 * @returns Every matching message; empty if none arrived within the budget.
 */
export async function findMailpitMessages(recipient: string): Promise<MailpitMessage[]> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    if (body.messages.length > 0) return body.messages
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

/**
 * Confirm no message ever arrives for one recipient, within a short budget
 * — the negative counterpart of `findMailpitMessages`. Used to prove a
 * rendering failure never reaches the transport at all: unlike
 * `findMailpitMessages`, this polls the FULL budget every time (there is no
 * "arrived" signal to short-circuit on), so it is used sparingly.
 * @param recipient - The `To:` address that must never receive anything.
 * @returns Resolves once the budget has elapsed with nothing found.
 */
export async function assertNoMailpitMessage(recipient: string): Promise<void> {
  const query = `to:${recipient}`
  const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
  const body = (await response.json()) as { messages: MailpitMessage[] }
  expect(body.messages).toHaveLength(0)
}

/**
 * Fetch one message's rendered parts by id.
 * @param id - The Mailpit message id.
 * @returns The message's HTML and plain-text bodies.
 */
export async function getMailpitMessage(id: string): Promise<MailpitMessageDetail> {
  const response = await fetch(`${MAILPIT_API}/message/${id}`)
  return (await response.json()) as MailpitMessageDetail
}

/**
 * Empty one recipient's mailbox, so a later assertion on the same address
 * is not confused by an earlier test's mail. Used by any test that
 * registers twice with one address.
 * @param recipient - The `To:` address to clear.
 */
export async function drainMailpit(recipient: string): Promise<void> {
  const messages = await findMailpitMessages(recipient)
  for (const message of messages) {
    await deleteMailpitMessage(message.ID)
  }
}

/**
 * Delete one message from Mailpit by id. Best-effort tidiness only, for a
 * mailbox shared across the whole test run — never asserted on, and scoped
 * to one message id so it cannot touch another test's in-flight mail.
 * @param id - The Mailpit message id.
 */
export async function deleteMailpitMessage(id: string): Promise<void> {
  try {
    await fetch(`${MAILPIT_API}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [id] }),
    })
  } catch {
    // Best-effort only — see this function's own comment.
  }
}
