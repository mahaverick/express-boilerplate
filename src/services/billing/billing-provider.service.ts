/**
 * @file The payment provider billing talks to: Razorpay, the local fake, or
 * none when payments are off. One client per process, so the Razorpay
 * client's per-subscription mutation queue covers every caller.
 */
import { billingProviderConfig } from '@/configs/billing.config'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { RazorpayProvider } from '@/services/billing/razorpay-provider.service'
import type { BillingProviderClient } from '@/types/billing'

/**
 * The process's client once built; undefined until the first call.
 */
let cached: BillingProviderClient | null | undefined

/**
 * The configured payment provider, built once and memoised for the process,
 * so a config change needs a restart. A test that varies the config calls
 * `vi.resetModules()` and imports this module afresh for each case.
 * @returns The client, or null when payments are off (no keys and no fake).
 */
export function getBillingProvider(): BillingProviderClient | null {
  if (cached !== undefined) return cached
  const config = billingProviderConfig()
  if (config === null) cached = null
  else if (config.kind === 'fake') cached = new FakeBillingProvider(config)
  else cached = new RazorpayProvider(config)
  return cached
}
