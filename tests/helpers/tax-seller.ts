/**
 * @file The registered seller every tax test issues as. A test turns
 * registration on by mocking `gstSellerConfig` to return it, so the env
 * stays untouched:
 * `vi.mock('@/configs/billing.config', async (importOriginal) => ({ ...(await importOriginal()), gstSellerConfig: () => FIXTURE_SELLER }))`,
 * with the helper loaded inside the factory.
 */
import type { GstSellerConfig } from '@/configs/billing.config'

/**
 * A Karnataka seller with the synthetic GSTIN `29AABCE1234F1Z1`, registered
 * from 1 April 2026 (00:00 IST), with the default prefixes.
 */
export const FIXTURE_SELLER: GstSellerConfig = {
  gstin: '29AABCE1234F1Z1',
  legalName: 'Mahaverick Labs Pvt Ltd',
  addressLines: ['12 MG Road', 'Bengaluru 560001'],
  stateCode: '29',
  sacCode: '998431',
  effectiveFrom: new Date('2026-03-31T18:30:00.000Z'),
  invoicePrefix: 'INV',
  creditNotePrefix: 'CN',
}
