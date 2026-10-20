/**
 * @file Process-wide socket defaults, applied once by `src/index.ts` before
 * anything connects. They cover every outbound connection: the analytics
 * proxy (`http-proxy-middleware`), and `fetch` (undici) in the analytics
 * drain, the flags client and the PostHog API client.
 */
import net from 'node:net'

/**
 * How long Node's happy-eyeballs gives each address before abandoning it and
 * trying the next. Node's default is 250 ms, and Node closes the abandoned
 * attempt rather than keeping it in flight, so a host whose TCP handshake
 * takes longer than that is never reached. Measured from the dev container
 * to PostHog's US ingest: a 256 ms median handshake (269 ms p90, 36 of 40
 * over 250 ms), so all 8 IPv4 attempts were cut off and the proxy answered
 * 504 after about 2.06 s. 1000 ms covers that handshake almost 4 times over.
 * An unreachable address that fails at once (`ENETUNREACH`) still costs
 * nothing; a silently dropped one costs up to this before the next is tried,
 * and a dead host with 8 addresses ends in 8 s, inside the proxy's 30 s idle
 * timeout.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 1000

/**
 * Apply the socket defaults. Happy-eyeballs stays on, so an address family
 * the host can't route still falls back to the other one.
 */
export function applyNetworkDefaults(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS)
}
