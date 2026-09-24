// tests/helpers/request.ts
import http, { type RequestListener } from 'node:http'
import supertest from 'supertest'

// Node-internal synchronous bind, deprecated as DEP0208: revisit on every Node upgrade.
type BindableServer = http.Server & {
  _listen2(address: string, port: number, addressType: number): void
}

/**
 * supertest over a server bound to 127.0.0.1, never `::`: on macOS, `listen(0)` on `::` can
 * take a port another process holds on 127.0.0.1, where supertest then sends the request.
 * @param app - The Express app (or any request listener) under test.
 * @returns A supertest agent for that app; supertest still starts and closes the server.
 */
export function request(app: RequestListener): ReturnType<typeof supertest> {
  const server = http.createServer(app)
  const bindable = server as BindableServer
  if (typeof bindable._listen2 !== 'function') {
    throw new TypeError('Server#_listen2 is gone (DEP0208): see tests/helpers/request.ts')
  }
  // listen(port, host) binds only after an async lookup, but supertest reads
  // address() right after its listen(0). Serves only that call: callback and backlog are ignored.
  server.listen = ((port?: number) => {
    bindable._listen2('127.0.0.1', port ?? 0, 4)
    return server
  }) as http.Server['listen']
  return supertest(server)
}
