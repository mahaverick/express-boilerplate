/**
 * @file Preloaded with `--import` into a child running `src/index.ts`
 * (tests/integration/process-fault.test.ts). It makes the child's server
 * bind a port the OS picks on 127.0.0.1, whatever `APP_PORT` says, and
 * print `process-fault-preload listening <port>` on stdout once it listens,
 * so the test never hands the child a port another process could take
 * first. The host is pinned too: a `::` bind can share a port another
 * process holds on 127.0.0.1, where the test connects. Once boot has
 * installed its `uncaughtException` listener, it throws an uncaught error
 * whose message carries the process's `Error.stackTraceLimit`, so the test
 * can read the limit boot set from the event the child reports.
 */
import net from 'node:net'

// eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied below with the server as `this`
const originalListen = net.Server.prototype.listen

/**
 * `net.Server#listen` with a numeric port replaced by 0 on 127.0.0.1,
 * reporting the port the OS chose once the server listens.
 * @param this - The server.
 * @param parameters - The arguments `listen` was called with.
 * @returns The server.
 */
function listenOnFreePort(this: net.Server, ...parameters: unknown[]): net.Server {
  if (typeof parameters[0] === 'number') {
    parameters[0] = 0
    if (typeof parameters[1] === 'string') parameters[1] = '127.0.0.1'
    else parameters.splice(1, 0, '127.0.0.1')
  }
  this.once('listening', () => {
    const address = this.address()
    if (address !== null && typeof address === 'object') {
      process.stdout.write(`process-fault-preload listening ${String(address.port)}\n`)
    }
  })
  return (originalListen as (...parameters: unknown[]) => net.Server).apply(this, parameters)
}

net.Server.prototype.listen = listenOnFreePort as typeof originalListen

const poll = setInterval(() => {
  if (process.listenerCount('uncaughtException') === 0) return
  clearInterval(poll)
  // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- V8's stack depth, the value under test
  throw new Error(`child process fault, stack limit ${String(Error.stackTraceLimit)}`)
}, 20)
