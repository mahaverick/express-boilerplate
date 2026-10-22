/**
 * @file Checks that the local test services (Postgres, Redis, Mailpit SMTP and
 * HTTP) accept a TCP connection. The pre-push gate runs it first, so a stopped
 * Docker stack fails in about two seconds instead of minutes into the
 * integration tests.
 */
import fs from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 1500

/**
 * Whether a TCP connection to host:port opens within the timeout.
 * @param host - The host to connect to.
 * @param port - The port to connect to.
 * @param timeoutMs - How long to wait before counting it as down.
 * @returns True when the connection opened.
 */
const accepts = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port })
    /**
     * Settle once and drop the socket.
     * @param up - Whether the connection opened.
     */
    const done = (up) => {
      socket.destroy()
      resolve(up)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

/**
 * Whether host:port accepts a connection. `localhost` is probed as 127.0.0.1
 * and ::1 directly: resolving it can stall for seconds on macOS, which would
 * report a running service as down.
 * @param host - The host to connect to.
 * @param port - The port to connect to.
 * @param timeoutMs - How long to wait before counting it as down.
 * @returns True when any address for the host accepted.
 */
const reachable = async (host, port, timeoutMs) => {
  if (host === '') return false
  const hosts = host.toLowerCase() === 'localhost' ? ['127.0.0.1', '::1'] : [host]
  const results = await Promise.all(hosts.map((each) => accepts(each, port, timeoutMs)))
  return results.includes(true)
}

/**
 * The host and port of a URL, with a default port when the URL has none.
 * @param value - The URL.
 * @param defaultPort - The port to use when the URL names none.
 * @returns The host and port; the host is empty when the URL is missing or invalid.
 */
const target = (value, defaultPort) => {
  try {
    const url = new URL(value ?? '')
    // URL keeps the brackets of an IPv6 literal (`[::1]`), which net.connect cannot resolve.
    return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port || defaultPort) }
  } catch {
    return { host: '', port: defaultPort }
  }
}

/**
 * Probe every test service at once.
 * @param env - The test env: DATABASE_URL, REDIS_URL, SMTP_HOST, SMTP_PORT and MAILPIT_URL.
 * @param [timeoutMs] - Per-probe timeout.
 * @returns The services that refused, in a fixed order.
 */
export async function checkTestServices(env, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const services = [
    ['postgres', target(env.DATABASE_URL, 5432)],
    ['redis', target(env.REDIS_URL, 6379)],
    ['mailpit-smtp', { host: env.SMTP_HOST ?? '127.0.0.1', port: Number(env.SMTP_PORT ?? 1025) }],
    ['mailpit-http', target(env.MAILPIT_URL ?? 'http://127.0.0.1:8025', 8025)],
  ]
  const up = await Promise.all(
    services.map(([, { host, port }]) => reachable(host, port, timeoutMs))
  )
  const down = services.filter((_, index) => !up[index]).map(([name]) => name)
  return down.length === 0 ? { ok: true } : { ok: false, down }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Same precedence as tests/helpers/env.ts: the shell, then .env.test.local, then .env.test.
  for (const file of ['.env.test.local', '.env.test']) {
    if (fs.existsSync(file)) process.loadEnvFile(file)
  }
  const result = await checkTestServices(process.env)
  if (!result.ok) {
    console.error(
      `Test services down: ${result.down.join(', ')}. Start them with: docker compose up -d postgres redis mailpit`
    )
    process.exitCode = 1
  }
}
