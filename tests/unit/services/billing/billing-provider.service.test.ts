/**
 * @file `getBillingProvider` builds the client the config names, none when
 * payments are off, and the same instance on every call.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { BillingProviderConfig } from '@/configs/billing.config'

const configMock = vi.hoisted(() => ({
  billingProviderConfig: vi.fn<() => BillingProviderConfig | null>(),
}))

vi.mock('@/configs/billing.config', () => configMock)

beforeEach(() => {
  vi.resetModules()
})

/**
 * Import the factory afresh, so its cache starts empty.
 * @returns The factory.
 */
async function freshFactory(): Promise<
  typeof import('@/services/billing/billing-provider.service').getBillingProvider
> {
  const module = await import('@/services/billing/billing-provider.service')
  return module.getBillingProvider
}

describe('getBillingProvider', () => {
  it('answers null when payments are off', async () => {
    configMock.billingProviderConfig.mockReturnValue(null)
    expect((await freshFactory())()).toBeNull()
  })

  it('builds the fake for the fake config', async () => {
    configMock.billingProviderConfig.mockReturnValue({
      kind: 'fake',
      mode: 'test',
      keyId: 'rzp_test_FAKE',
      keySecret: 'fake_key_secret',
      webhookSecrets: ['fake_webhook_secret'],
    })
    const provider = (await freshFactory())()
    expect(provider?.kind).toBe('fake')
    expect(provider?.keyId).toBe('rzp_test_FAKE')
  })

  it('builds one Razorpay client in the key mode and reuses it', async () => {
    configMock.billingProviderConfig.mockReturnValue({
      kind: 'razorpay',
      mode: 'live',
      keyId: 'rzp_live_FAKEkey',
      keySecret: 'secret_FAKE',
      webhookSecrets: ['probe_webhook_secret'],
    })
    const getBillingProvider = await freshFactory()
    const provider = getBillingProvider()
    expect(provider?.kind).toBe('razorpay')
    expect(provider?.mode).toBe('live')
    expect(getBillingProvider()).toBe(provider)
    expect(configMock.billingProviderConfig).toHaveBeenCalledTimes(1)
  })
})
