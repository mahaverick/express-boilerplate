/**
 * @file Drives the real express.json() configured in src/app.ts, not a
 * hand-rolled error object, since Express's body parser throws
 * `http-errors` instances rather than HttpError. Body parsing runs before
 * routing, so POSTing to an existing path is enough — no route, database
 * or Redis is ever reached.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createApp } from '@/app'
import { logger } from '@/services/logger.service'
import { request } from '../../helpers/request'

const app = createApp()

describe('body-parser errors reach the client as client errors', () => {
  let loggerError: Mock

  beforeEach(() => {
    loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers 400, not 500, for malformed JSON', async () => {
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":')

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ success: false, statusCode: 400 })
  })

  it('does not log malformed JSON at server severity', async () => {
    // A typo'd client request is not a server fault; logging it via logger.error would dilute that signal.
    await request(app).post('/health').set('Content-Type', 'application/json').send('{"broken":')

    expect(loggerError).not.toHaveBeenCalled()
  })

  it('answers 413, not 500, for a body over the 1mb limit', async () => {
    // body-parser rejects on Content-Length before reading the stream, so this stays cheap despite the 1mb payload.
    const oversize = JSON.stringify({ blob: 'a'.repeat(1024 * 1024) })
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send(oversize)

    expect(response.status).toBe(413)
    expect(response.body).toMatchObject({ success: false, statusCode: 413 })
  })

  it('does not log an oversize body at server severity', async () => {
    const oversize = JSON.stringify({ blob: 'a'.repeat(1024 * 1024) })
    await request(app).post('/health').set('Content-Type', 'application/json').send(oversize)

    expect(loggerError).not.toHaveBeenCalled()
  })

  it('still reaches the 404 catch-all for a well-formed body on an unknown route', async () => {
    // Guards the other direction: the parser must not reject valid requests while rejecting invalid ones.
    const response = await request(app)
      .post('/api/v1/nope')
      .set('Content-Type', 'application/json')
      .send({ ok: true })

    expect(response.status).toBe(404)
  })
})

describe('express.urlencoded is configured with an explicit limit', () => {
  it('pins the option in src/app.ts, not just body-parser’s own default', () => {
    // body-parser's own default urlencoded limit is already 100kb; this pins it explicitly so a future body-parser major cannot silently loosen it.
    const source = readFileSync(path.resolve(process.cwd(), 'src/app.ts'), 'utf8')
    expect(source).toMatch(/express\.urlencoded\(\{\s*extended:\s*false,\s*limit:\s*'100kb'\s*\}\)/)
  })

  it('still answers 413, not 500, for a urlencoded body over 100kb', async () => {
    const oversize = `blob=${'a'.repeat(101 * 1024)}`
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(oversize)

    expect(response.status).toBe(413)
    expect(response.body).toMatchObject({ success: false, statusCode: 413 })
  })

  it('reaches the 404 catch-all for a well-formed urlencoded body on an unknown route', async () => {
    const response = await request(app)
      .post('/api/v1/nope')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('ok=true')

    expect(response.status).toBe(404)
  })
})
