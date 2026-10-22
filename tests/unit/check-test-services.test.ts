/**
 * @file `checkTestServices` reports which local test services refuse a TCP
 * connection, so the pre-push gate fails in seconds when the Docker stack is
 * down instead of minutes into the integration tests.
 */
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { checkTestServices } from '../../scripts/check-test-services.mjs'

const servers: net.Server[] = []

/**
 * Listen on an ephemeral port of one loopback address (never `::`, which can
 * collide with a 127.0.0.1 port on macOS).
 * @param host - The loopback address to bind.
 * @returns The listening server and its port.
 */
const listen = async (host = '127.0.0.1'): Promise<{ server: net.Server; port: number }> => {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

/**
 * A port nothing listens on: bound once, then closed.
 * @returns The closed port.
 */
const freePort = async (): Promise<number> => {
  const { server, port } = await listen()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * The service env for four ports.
 * @param ports - Postgres, Redis, Mailpit SMTP and Mailpit HTTP ports.
 * @param host - The host every service is on.
 * @returns The env `checkTestServices` reads.
 */
const envFor = ([db, redis, smtp, http]: number[], host = '127.0.0.1'): Record<string, string> => ({
  DATABASE_URL: `postgres://t:t@${host}:${String(db)}/x`,
  REDIS_URL: `redis://${host}:${String(redis)}`,
  SMTP_HOST: host,
  SMTP_PORT: String(smtp),
  MAILPIT_URL: `http://${host}:${String(http)}`,
})

/**
 * Whether this machine can bind the IPv6 loopback address.
 * @returns True when a listener on ::1 starts.
 */
const canBindIpv6 = async (): Promise<boolean> => {
  try {
    const { server } = await listen('::1')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return true
  } catch {
    return false
  }
}

const ipv6 = await canBindIpv6()

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('checkTestServices', () => {
  it('reports every service that refuses a connection', async () => {
    const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()])

    await expect(checkTestServices(envFor(ports))).resolves.toEqual({
      ok: false,
      down: ['postgres', 'redis', 'mailpit-smtp', 'mailpit-http'],
    })
  })

  it('passes when every port accepts', async () => {
    const listening = await Promise.all([listen(), listen(), listen(), listen()])
    servers.push(...listening.map(({ server }) => server))

    const env = envFor(listening.map(({ port }) => port))

    await expect(checkTestServices(env)).resolves.toEqual({ ok: true })
  })

  it('treats localhost as up when 127.0.0.1 accepts', async () => {
    const listening = await Promise.all([listen(), listen(), listen(), listen()])
    servers.push(...listening.map(({ server }) => server))
    const env = envFor(
      listening.map(({ port }) => port),
      'localhost'
    )

    await expect(checkTestServices(env)).resolves.toEqual({ ok: true })
  })

  it.skipIf(!ipv6)('reaches a bracketed IPv6 literal in a URL', async () => {
    const listening = await Promise.all([listen('::1'), listen(), listen(), listen()])
    servers.push(...listening.map(({ server }) => server))
    const [db, ...rest] = listening.map(({ port }) => port)
    const env = { ...envFor([0, ...rest]), DATABASE_URL: `postgres://t:t@[::1]:${String(db)}/x` }

    await expect(checkTestServices(env)).resolves.toEqual({ ok: true })
  })

  it('gives up within the timeout', async () => {
    const started = performance.now()

    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a reserved, unroutable private address, so the connect hangs until the timeout
    const result = await checkTestServices(envFor([5432, 6379, 1025, 8025], '10.255.255.1'), 300)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(result).toEqual({
      ok: false,
      down: ['postgres', 'redis', 'mailpit-smtp', 'mailpit-http'],
    })
  })
})
