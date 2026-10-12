/**
 * @file Mailpit's own HTTP API, shared by every test that asserts on
 * outbound mail.
 */
import { expect } from 'vitest'
import { settle } from './timing'

/**
 * Mailpit's HTTP API: `MAILPIT_URL` (test env, `.env.test.local` or the shell) or the compose stack's.
 * Read per call, after `tests/helpers/setup-global.ts` has loaded the test env.
 * @returns The API base URL, with one trailing slash, if any, dropped.
 */
function mailpitApi(): string {
  const base = process.env.MAILPIT_URL?.trim() || 'http://localhost:8025'
  return `${base.replace(/\/$/, '')}/api/v1`
}

/**
 * One hit in a Mailpit search result.
 */
export interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

/**
 * A message's full content, as Mailpit's message endpoint returns it.
 */
export interface MailpitMessageDetail {
  HTML: string
  Text: string
  From: { Address: string }
  MessageID: string
}

/**
 * Poll Mailpit for messages to one recipient, up to 30 searches 100 ms apart:
 * an SMTP delivery is not synchronous with the message becoming searchable.
 * @param recipient - The `To:` address to search for.
 * @returns Every matching message; empty if none showed up in the polls.
 */
export async function findMailpitMessages(recipient: string): Promise<MailpitMessage[]> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${mailpitApi()}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    if (body.messages.length > 0) return body.messages
    await settle(100, 'poll interval')
  }
  return []
}

/**
 * Assert that no message reaches one recipient during 10 searches 100 ms
 * apart, the negative counterpart of `findMailpitMessages`. Absence has no
 * event to wait on, so it always polls the whole span; use it sparingly.
 *
 * A single fetch would pass whether or not mail is still in flight. Polling
 * the whole span fails the test when a fire-and-forget send lands mid-window.
 * @param recipient - The `To:` address that must receive nothing.
 * @returns Resolves once the polls end with nothing found.
 * @throws {Error} When a message to the recipient shows up.
 */
export async function assertNoMailpitMessage(recipient: string): Promise<void> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${mailpitApi()}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    expect(body.messages).toHaveLength(0)
    await settle(100, 'poll interval: absence has no event, so the whole budget is polled')
  }
}

/**
 * Fetch one message's rendered bodies and sender, to assert on what was sent.
 * @param id - The Mailpit message id.
 */
export async function getMailpitMessage(id: string): Promise<MailpitMessageDetail> {
  const response = await fetch(`${mailpitApi()}/message/${id}`)
  return (await response.json()) as MailpitMessageDetail
}

/**
 * Delete the messages to one recipient, so a later assertion on the same
 * address is not confused by an earlier test's mail. It searches with
 * `findMailpitMessages`, so it also waits out those polls when nothing is there.
 * @param recipient - The `To:` address to clear.
 */
export async function drainMailpit(recipient: string): Promise<void> {
  const messages = await findMailpitMessages(recipient)
  for (const message of messages) {
    await deleteMailpitMessage(message.ID)
  }
}

/**
 * Delete one message from Mailpit by id, ignoring failure. The mailbox is
 * shared across the whole test run, so this is scoped to one id and cannot
 * touch another test's in-flight mail.
 * @param id - The Mailpit message id.
 */
export async function deleteMailpitMessage(id: string): Promise<void> {
  try {
    await fetch(`${mailpitApi()}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [id] }),
    })
  } catch {
    // A failed delete is ignored: the mailbox is only tidied, never asserted on.
  }
}
