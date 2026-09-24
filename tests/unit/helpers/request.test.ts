// tests/unit/helpers/request.test.ts
//
// No database, no Redis: a bare request listener that answers with the
// local address the connection arrived on.
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from '../../helpers/request'

/**
 * Answer every request with the address the server accepted it on.
 * @param incoming - The incoming request.
 * @param response - The response.
 */
function echoLocalAddress(incoming: IncomingMessage, response: ServerResponse): void {
  response.end(incoming.socket.localAddress)
}

describe('request helper', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('binds the server supertest starts to 127.0.0.1, not ::', async () => {
    const response = await request(echoLocalAddress).get('/')

    expect(response.status).toBe(200)
    expect(response.text).toBe('127.0.0.1')
  })

  it('serves sequential requests from one factory and closes the server after each', async () => {
    const createServer = vi.spyOn(http, 'createServer')
    const agent = request(echoLocalAddress)
    const server = createServer.mock.results[0]?.value as Server

    const first = await agent.get('/')
    expect(server.listening).toBe(false)
    const second = await agent.get('/')

    expect(first.text).toBe('127.0.0.1')
    expect(second.text).toBe('127.0.0.1')
    expect(server.listening).toBe(false)
  })
})
