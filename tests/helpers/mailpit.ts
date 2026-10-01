/**
 * @file Mailpit's own HTTP API, shared by every test that asserts on
 * outbound mail.
 */
import { expect } from 'vitest'
import { settle } from './timing'

const MAILPIT_API = 'http://localhost:8025/api/v1'

export interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

export interface MailpitMessageDetail {
  HTML: string
  Text: string
  From: { Address: string }
  MessageID: string
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
    await settle(100, 'poll interval')
  }
  return []
}

/**
 * Confirm no message ever arrives for one recipient, within a short budget
 * — the negative counterpart of `findMailpitMessages`. Used to prove a
 * rendering failure never reaches the transport at all: unlike
 * `findMailpitMessages`, this polls the FULL budget every time (there is no
 * "arrived" signal to short-circuit on), so it is used sparingly.
 *
 * A single unwaited fetch here would pass whether or not anything is ever
 * going to arrive; see CLAUDE.md for why that shape is a false negative.
 * This loops for the whole budget so a message that lands mid-window — a
 * real risk for a caller racing a fire-and-forget mail send against a
 * negative assertion — still fails it.
 * @param recipient - The `To:` address that must never receive anything.
 * @returns Resolves once the budget has elapsed with nothing found.
 */
export async function assertNoMailpitMessage(recipient: string): Promise<void> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    expect(body.messages).toHaveLength(0)
    await settle(100, 'poll interval: absence has no event, so the whole budget is polled')
  }
}

/**
 * Fetch one message's rendered parts and headers by id.
 * @param id - The Mailpit message id.
 * @returns The message's HTML and plain-text bodies, its From address and its Message-ID.
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
    // Best-effort: see this function's own JSDoc.
  }
}
