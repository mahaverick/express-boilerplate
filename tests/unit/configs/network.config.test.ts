/**
 * @file The process-wide connect-attempt timeout. Node's happy-eyeballs
 * abandons each address after the attempt timeout (250 ms by default) and
 * tries the next; with a 256 ms handshake to PostHog's ingest every attempt
 * was cut short, and `/api/v1/collect` answered 504 after 16 attempts and
 * about 2.06 s. A local handshake can't be made slower than 250 ms, so these
 * tests pin the setting and that boot applies it before anything connects.
 */
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { applyNetworkDefaults, CONNECT_ATTEMPT_TIMEOUT_MS } from '@/configs/network.config'

const nodeDefault = net.getDefaultAutoSelectFamilyAttemptTimeout()

describe('applyNetworkDefaults', () => {
  afterEach(() => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(nodeDefault)
  })

  it('sets the connect-attempt timeout every socket uses to CONNECT_ATTEMPT_TIMEOUT_MS', () => {
    applyNetworkDefaults()

    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS)
  })

  it('keeps happy-eyeballs on, so an unreachable IPv6 address still falls back to IPv4', () => {
    applyNetworkDefaults()

    expect(net.getDefaultAutoSelectFamily()).toBe(true)
  })
})

describe('src/index.ts', () => {
  it('applies the network defaults first in main(), before the environment check and boot', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const main = source.slice(source.indexOf('function main(): void {'))

    expect(source).toMatch(
      /^import \{ applyNetworkDefaults \} from '@\/configs\/network\.config'$/m
    )
    expect(main.indexOf('applyNetworkDefaults()')).toBeGreaterThan(-1)
    expect(main.indexOf('applyNetworkDefaults()')).toBeLessThan(
      main.indexOf('assertEnvConsistent(')
    )
    expect(main.indexOf('applyNetworkDefaults()')).toBeLessThan(main.indexOf('void boot()'))
  })
})
