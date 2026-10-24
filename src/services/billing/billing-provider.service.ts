/**
 * @file The payment provider billing talks to: Razorpay, the local fake, or
 * none when payments are off. One client per process, so the Razorpay
 * client's per-subscription mutation queue covers every caller. Also the
 * mapping of a provider failure to the HTTP answer every billing request shares.
 */
import { billingProviderConfig } from '@/configs/billing.config'
import { PAYMENT_PROVIDER_UNAVAILABLE_CODE } from '@/constants/billing.constants'
import { ProviderError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
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

/**
 * How long a client waits before retrying a write that found the provider
 * down or the row busy.
 */
export const RETRY_AFTER_SECONDS = 30

/**
 * A provider failure as the HTTP answer: 503 with a retry wait when the
 * provider may answer later, 502 when it refused the call. Either reports
 * the failure as its cause; nothing was written.
 * @param error - What the provider call threw.
 * @param refusedMessage - The 502's message, for a caller whose action is not a change.
 * @returns The error to throw.
 */
export function providerFailure(
  error: unknown,
  refusedMessage = 'Our payment provider declined this change. Contact support if it happens again.'
): Error {
  if (!(error instanceof ProviderError)) {
    return error instanceof Error ? error : new Error('A billing step failed', { cause: error })
  }
  return new HttpError(
    error.retryable
      ? 'Our payment provider did not answer. Try again in 30 seconds.'
      : refusedMessage,
    error.retryable ? 503 : 502,
    PAYMENT_PROVIDER_UNAVAILABLE_CODE,
    undefined,
    { cause: error, ...(error.retryable && { retryAfterSeconds: RETRY_AFTER_SECONDS }) }
  )
}

/**
 * Run a provider call, mapping its failure to the HTTP answer.
 * @param call - The call.
 * @param refusedMessage - The 502's message, when the default's "change" does not fit.
 * @returns What the call returns.
 * @throws {HttpError} 503 when the provider may answer later, 502 when it refused the call.
 */
export async function callProvider<T>(call: () => Promise<T>, refusedMessage?: string): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw providerFailure(error, refusedMessage)
  }
}
