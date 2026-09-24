// tests/helpers/redis-proxy.ts
//
// A real Redis outage without touching the shared compose Redis: clients
// connect through this TCP proxy, and the outage is the proxy resetting every
// connection.
//
// The proxy holds one port for its whole life: re-listening on a hand-picked
// port could take over another worker's test server on that port.
import net from 'node:net'

// `down` resets every connection; `silent` accepts connections and never answers.
type ProxyMode = 'up' | 'down' | 'silent'

/**
 * A TCP proxy to Redis that a test can take down, silence and bring back.
 */
export class RedisProxy {
  private server: net.Server | undefined
  private readonly sockets = new Set<net.Socket>()
  private mode: ProxyMode = 'up'
  port = 0

  private switchTo(mode: ProxyMode): void {
    this.mode = mode
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /**
   * Listen on an ephemeral port on 127.0.0.1, forwarding to `upstream`.
   * @param upstream - The real Redis URL.
   * @returns Resolves once listening; `port` is set.
   */
  async start(upstream: URL): Promise<void> {
    const server = net.createServer((client) => {
      if (this.mode === 'down') {
        client.resetAndDestroy()
        return
      }
      this.sockets.add(client)
      client.on('error', () => client.destroy()).on('close', () => this.sockets.delete(client))
      if (this.mode === 'silent') return

      const toRedis = net.connect(Number(upstream.port || 6379), upstream.hostname)
      this.sockets.add(toRedis)
      client.pipe(toRedis).pipe(client)
      const teardown = (): void => {
        client.destroy()
        toRedis.destroy()
        this.sockets.delete(client)
        this.sockets.delete(toRedis)
      }
      client.on('error', teardown).on('close', teardown)
      toRedis.on('error', teardown).on('close', teardown)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (server.address() as net.AddressInfo).port
    this.server = server
  }

  /**
   * The Redis URL that reaches `upstream` through this proxy.
   * @param upstream - The real Redis URL.
   * @returns `upstream` with its host and port pointed at the proxy.
   */
  urlFor(upstream: URL): string {
    const proxied = new URL(upstream)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(this.port)
    return proxied.href
  }

  /**
   * Reset every open connection, and every new one until `comeBack()`.
   */
  goDown(): void {
    this.switchTo('down')
  }

  /**
   * Accept connections but never answer.
   */
  goSilent(): void {
    this.switchTo('silent')
  }

  /**
   * Forward again. Leaves live connections alone when already up; otherwise drops silent ones.
   */
  comeBack(): void {
    if (this.mode !== 'up') this.switchTo('up')
  }

  /**
   * Reset every connection and stop listening.
   */
  close(): void {
    this.switchTo('down')
    this.server?.close()
    this.server = undefined
  }
}

/**
 * Wait `ms` milliseconds.
 * @param ms - How long to wait.
 * @returns Resolves after the delay.
 */
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `isDone` every 100ms until it is true or `timeoutMs` passes.
 * @param isDone - The condition.
 * @param timeoutMs - How long to keep polling.
 * @returns Whether the condition became true in time.
 */
export async function isEventuallyTrue(
  isDone: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDone()) return true
    await sleep(100)
  }
  return false
}
