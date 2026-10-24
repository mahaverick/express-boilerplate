/**
 * @file The public plan list a signed-out pricing page reads: each plan with
 * every entitlement (a key the plan does not set reads its registry default)
 * and its active prices, the entitlement catalog, the trial and payment
 * switches. Nothing provider-side leaves here: prices go through
 * `toPriceView`, and the catalog drops the registry's own defaults.
 */
import { getEnv } from '@/configs/env.config'
import type { BillingInterval, PlanKey } from '@/constants/billing.constants'
import {
  entitlementCatalog,
  type EntitlementCatalogEntry,
  type EntitlementValue,
} from '@/constants/entitlements.constants'
import { toPriceView, type PriceView } from '@/presenters/billing.presenter'
import { PlanRepository } from '@/repositories/plan.repository'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { mergeEntitlements } from '@/utilities/billing-rules.utilities'

const planRepository = new PlanRepository()

/**
 * The order prices are listed in.
 */
const INTERVAL_ORDER: Record<BillingInterval, number> = { month: 0, year: 1 }

/**
 * One plan as the public list shows it.
 */
interface PublicPlan {
  key: PlanKey
  name: string
  description: string
  sortOrder: number
  entitlements: Record<string, EntitlementValue>
  prices: PriceView[]
}

/**
 * The public plan list.
 */
export interface PublicPlans {
  plans: PublicPlan[]
  catalog: Pick<EntitlementCatalogEntry, 'key' | 'kind' | 'label' | 'description'>[]
  trial: { enabled: boolean; days: number }
  paymentsEnabled: boolean
  gstRegistered: boolean
}

/**
 * The plans, their active INR prices with no country, month before year,
 * and the switches a pricing page needs.
 * @param now - The time the plan values are read at.
 * @returns The list.
 */
export async function listPublicPlans(now = new Date()): Promise<PublicPlans> {
  const rows = await planRepository.listPlans()
  const plans = await Promise.all(
    rows.map(async (plan): Promise<PublicPlan> => {
      const prices = await planRepository.listPrices(plan.id)
      return {
        key: plan.key,
        name: plan.name,
        description: plan.description ?? '',
        sortOrder: plan.sortOrder,
        entitlements: mergeEntitlements(plan.key, plan.entitlements, [], now).values,
        prices: prices
          .filter((price) => price.active && price.country === null && price.currency === 'INR')
          .toSorted((a, b) => INTERVAL_ORDER[a.interval] - INTERVAL_ORDER[b.interval])
          .map((price) => toPriceView(price)),
      }
    })
  )
  const settings = await planRepository.getSettings()
  return {
    plans,
    catalog: entitlementCatalog().map(({ key, kind, label, description }) => ({
      key,
      kind,
      label,
      description,
    })),
    trial: { enabled: settings.trialEnabled, days: settings.trialDays },
    paymentsEnabled: getBillingProvider() !== null,
    gstRegistered: getEnv().BILLING_GST_REGISTERED,
  }
}
