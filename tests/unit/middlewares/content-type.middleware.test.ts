// tests/unit/middlewares/content-type.middleware.test.ts
//
// No database, no Redis, no app — a bare `express()` with the middleware in
// front of a stub handler, which is what keeps this a tests/unit/ file (see
// CLAUDE.md on why a Docker-dependent test must never live there). The
// end-to-end proof that the real auth router rejects a cross-site form POST
// lives in tests/integration/api/auth.test.ts.
import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import {
  requireJsonContentType,
  UNSUPPORTED_MEDIA_TYPE_CODE,
} from '@/middlewares/content-type.middleware'
import { errorHandler } from '@/middlewares/error.middleware'

/**
 * Build a bare app with the gate in front of a stub handler that answers
 * 200 for anything reaching it.
 * @returns The app.
 */
function buildApp(): Express {
  const app = express()
  app.use(requireJsonContentType)
  app.post('/endpoint', (_request, response) => {
    response.status(200).json({ success: true })
  })
  app.use(errorHandler)
  return app
}

describe('requireJsonContentType', () => {
  it('rejects a form-encoded body with 415 — the encoding a cross-site HTML form produces', async () => {
    const response = await request(buildApp())
      .post('/endpoint')
      .type('form')
      .send({ email: 'victim@example.com', password: 'attacker-chosen' })

    expect(response.status).toBe(415)
    expect(response.body).toMatchObject({ success: false, code: UNSUPPORTED_MEDIA_TYPE_CODE })
  })

  it('rejects the other two encodings a form can produce', async () => {
    // multipart/form-data and text/plain complete the set the HTML spec
    // allows a form to submit; refusing all three is what removes the form
    // vector by construction rather than case by case.
    const multipart = await request(buildApp())
      .post('/endpoint')
      .field('email', 'victim@example.com')
    const text = await request(buildApp())
      .post('/endpoint')
      .type('text/plain')
      .send('{"email":"victim@example.com"}')

    expect(multipart.status).toBe(415)
    expect(text.status).toBe(415)
  })

  it('accepts application/json', async () => {
    const response = await request(buildApp()).post('/endpoint').send({ email: 'a@example.com' })

    expect(response.status).toBe(200)
  })

  it('accepts application/json with a charset parameter', async () => {
    const response = await request(buildApp())
      .post('/endpoint')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send('{"email":"a@example.com"}')

    expect(response.status).toBe(200)
  })

  it('accepts a request declaring no content type at all', async () => {
    // /refresh and /logout are legitimately called with no body. An untyped
    // body is inert anyway — neither express.json() nor express.urlencoded()
    // parses one — so nothing an attacker sends this way reaches a
    // validator. See the middleware's own header comment.
    const response = await request(buildApp()).post('/endpoint')

    expect(response.status).toBe(200)
  })
})
