/**
 * @file Billing dates as a workspace's people read them: the date alone, in
 * the workspace's time zone (`tenant_settings.timezone`, UTC when unset), so
 * it matches the day on the customer's bank message. Security mail keeps its
 * UTC times (`formatUtcDateTime`).
 */
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { formatDateInZone } from '@/utilities/date-text.utilities'

const settingsRepository = new TenantSettingsRepository()

/**
 * The time zone a workspace's billing dates are read in.
 * @param tenantId - The workspace.
 * @returns Its IANA zone name, or `UTC` when it has no settings row.
 */
export async function billingTimeZone(tenantId: string): Promise<string> {
  const settings = await settingsRepository.findByTenantId(tenantId)
  return settings?.timezone ?? 'UTC'
}

/**
 * A billing date as the workspace's people read it.
 * @param tenantId - The workspace.
 * @param date - The moment.
 * @returns For example "2 November 2026".
 */
export async function formatBillingDate(tenantId: string, date: Date): Promise<string> {
  return formatDateInZone(date, await billingTimeZone(tenantId))
}
