/**
 * @file `pnpm email:fire-event`: argument parsing, and the request it
 * signs and posts, through an injected fetch. A `<…>` message id needs no
 * database, so nothing here reaches Postgres. Importing the script does not
 * run it: it acts only when it is the entry module.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { parseFireEventArguments, runFireEvent } from '@/scripts/email-fire-event'

const USAGE = 'Usage: pnpm email:fire-event <messageId> <type> [hard|soft] [--origin <api origin>]'

describe('parseFireEventArguments', () => {
  it('reads the id and type after the pnpm separator', () => {
    expect(parseFireEventArguments(['--', 'm1', 'delivered'])).toEqual({
      messageId: 'm1',
      type: 'delivered',
    })
  })

  it('defaults a bounce to hard and reads soft', () => {
    expect(parseFireEventArguments(['m1', 'bounced'])).toMatchObject({ bounceKind: 'hard' })
    expect(parseFireEventArguments(['m1', 'bounced', 'soft'])).toMatchObject({
      bounceKind: 'soft',
    })
  })

  it('reads --origin wherever it appears', () => {
    expect(
      parseFireEventArguments(['--origin', 'http://127.0.0.1:4041', 'm1', 'bounced', 'hard'])
    ).toEqual({
      messageId: 'm1',
      type: 'bounced',
      bounceKind: 'hard',
      origin: 'http://127.0.0.1:4041',
    })
  })

  it('refuses an unknown type, naming the allowed ones', () => {
    expect(() => parseFireEventArguments(['m1', 'sent'])).toThrow(
      'Unknown type "sent". Use one of: delivered, deferred, bounced, complained, opened, clicked, failed'
    )
  })

  it('refuses an unknown bounce kind, and a kind on a non-bounce', () => {
    expect(() => parseFireEventArguments(['m1', 'bounced', 'medium'])).toThrow(
      'Unknown bounce kind "medium". Use hard or soft'
    )
    expect(() => parseFireEventArguments(['m1', 'delivered', 'hard'])).toThrow(USAGE)
  })

  it('refuses an origin that is not http(s)', () => {
    expect(() =>
      parseFireEventArguments(['m1', 'delivered', '--origin', 'mailto:ops@example.test'])
    ).toThrow('--origin must be an http(s) URL, got "mailto:ops@example.test"')
  })

  it.each([
    [[]],
    [['m1']],
    [['m1', 'bounced', 'hard', 'extra']],
    [['m1', 'delivered', '--origin']],
  ])('prints usage for %j', (argv) => {
    expect(() => parseFireEventArguments(argv)).toThrow(USAGE)
  })
})

describe('runFireEvent', () => {
  it('posts one signed event to the fake webhook on APP_URL', async () => {
    const post = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"success":true}', { status: 200 }))
    )
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      expect(await runFireEvent(['<m1@example.test>', 'bounced', 'soft'], post)).toBe(0)
    } finally {
      stdout.mockRestore()
    }

    const [url, init] = post.mock.calls[0] ?? []
    expect(url).toBe(`${new URL(getEnv().APP_URL).origin}/api/v1/webhooks/email/fake`)
    const sent = init?.body as Buffer
    const headers = init?.headers as Record<string, string>
    expect(headers['x-fake-signature']).toBe(
      createHmac('sha256', getEnv().FAKE_EMAIL_WEBHOOK_SECRET).update(sent).digest('hex')
    )
    expect(JSON.parse(sent.toString('utf8'))).toMatchObject({
      type: 'bounced',
      bounceKind: 'soft',
      messageId: '<m1@example.test>',
      id: expect.stringMatching(/^fake-/) as unknown,
    })
  })

  it('exits 1 on a non-2xx answer', async () => {
    const post = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 404 })))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(await runFireEvent(['<m1@example.test>', 'delivered'], post)).toBe(1)
    } finally {
      stdout.mockRestore()
    }
  })
})
