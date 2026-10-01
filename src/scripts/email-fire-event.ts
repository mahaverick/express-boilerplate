/**
 * @file `pnpm email:fire-event <messageId> <type> [hard|soft] [--origin <api origin>]`:
 * sign one event with `FAKE_EMAIL_WEBHOOK_SECRET` and post it to the fake
 * email webhook, as a provider would. For local development and the live
 * e2e; the fake adapter is served only on APP_ENV local. `<messageId>` is an
 * `email_messages.id`, whose Message-ID header is read from the database, or
 * a `<…>` header itself, which needs no database.
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { getEnv } from '@/configs/env.config'
import {
  BOUNCE_KINDS,
  EMAIL_EVENT_TYPES,
  type BounceKind,
  type EmailEventType,
} from '@/constants/email.constants'
import { closeDatabase } from '@/services/database.service'
import {
  FAKE_EMAIL_WEBHOOK_PROVIDER,
  FAKE_SIGNATURE_HEADER,
  fakeEmailWebhookSignature,
  messageIdHeaderFor,
} from '@/services/email-webhook-fake.service'

const USAGE = 'Usage: pnpm email:fire-event <messageId> <type> [hard|soft] [--origin <api origin>]'

const typeSchema = z.enum(EMAIL_EVENT_TYPES)
const bounceKindSchema = z.enum(BOUNCE_KINDS)
const originSchema = z.url({ protocol: /^https?$/ })

/**
 * The script's validated arguments.
 */
export interface FireEventArguments {
  messageId: string
  type: EmailEventType
  bounceKind?: BounceKind
  origin?: string
}

/**
 * Take `--origin <value>` out of the argument list.
 * @param argv - The arguments, pnpm's `--` removed.
 * @returns The origin, if given, and the remaining positional arguments.
 * @throws {Error} The usage line when `--origin` has no value.
 */
function withoutOrigin(argv: readonly string[]): { origin?: string; positional: string[] } {
  const at = argv.indexOf('--origin')
  if (at === -1) return { positional: [...argv] }
  const origin = argv[at + 1]
  if (origin === undefined) throw new Error(USAGE)
  return { origin, positional: [...argv.slice(0, at), ...argv.slice(at + 2)] }
}

/**
 * Read the command line, ignoring pnpm's `--`.
 * @param argv - The arguments after the script path.
 * @returns The message id, event type, bounce kind (bounces only) and origin.
 * @throws {Error} The usage line for a missing or extra argument; the allowed values for an unknown type, bounce kind or origin.
 */
export function parseFireEventArguments(argv: readonly string[]): FireEventArguments {
  const { origin, positional } = withoutOrigin(argv.filter((argument) => argument !== '--'))
  const [messageId, type, kind, ...extra] = positional
  if (messageId === undefined || type === undefined || extra.length > 0) throw new Error(USAGE)
  const parsedType = typeSchema.safeParse(type)
  if (!parsedType.success) {
    throw new Error(`Unknown type "${type}". Use one of: ${EMAIL_EVENT_TYPES.join(', ')}`)
  }
  if (kind !== undefined && parsedType.data !== 'bounced') throw new Error(USAGE)
  const parsedKind = bounceKindSchema.safeParse(kind ?? 'hard')
  if (!parsedKind.success) throw new Error(`Unknown bounce kind "${kind}". Use hard or soft`)
  if (origin !== undefined && !originSchema.safeParse(origin).success) {
    throw new Error(`--origin must be an http(s) URL, got "${origin}"`)
  }
  return {
    messageId,
    type: parsedType.data,
    ...(parsedType.data === 'bounced' && { bounceKind: parsedKind.data }),
    ...(origin !== undefined && { origin }),
  }
}

/**
 * The Message-ID header to send: the argument itself when it is one, else
 * the stored message's.
 * @param messageId - The `<messageId>` argument.
 * @returns The header.
 * @throws {Error} When no message has that id.
 */
async function headerFor(messageId: string): Promise<string> {
  if (messageId.startsWith('<')) return messageId
  const header = await messageIdHeaderFor(messageId)
  if (header === undefined) throw new Error(`No email message with id ${messageId}`)
  return header
}

/**
 * Parse the arguments, sign one fake event and post it, printing the
 * response.
 * @param argv - The arguments after the script path.
 * @param post - The HTTP client; injectable for tests.
 * @returns The process exit code: 0 when the API answered 2xx, 1 otherwise.
 */
export async function runFireEvent(
  argv: readonly string[],
  post: typeof fetch = fetch
): Promise<number> {
  try {
    const parsed = parseFireEventArguments(argv)
    const env = getEnv()
    const body = Buffer.from(
      JSON.stringify({
        id: `fake-${randomUUID()}`,
        type: parsed.type,
        messageId: await headerFor(parsed.messageId),
        ...(parsed.bounceKind !== undefined && { bounceKind: parsed.bounceKind }),
        occurredAt: new Date().toISOString(),
      })
    )
    const { origin } = new URL(parsed.origin ?? env.APP_URL)
    const response = await post(`${origin}/api/v1/webhooks/email/${FAKE_EMAIL_WEBHOOK_PROVIDER}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: fakeEmailWebhookSignature(body, env.FAKE_EMAIL_WEBHOOK_SECRET),
      },
      body,
    })
    process.stdout.write(`${response.status} ${await response.text()}\n`)
    return response.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFireEvent(process.argv.slice(2))
  await closeDatabase()
}
