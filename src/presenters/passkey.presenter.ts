/**
 * @file Passkey rows to their wire shape. The credential ID, the public key,
 * the counters and the AAGUID stay on the server.
 */
import type { UserPasskeyRecord } from '@/database/models/user-passkey.model'
import { passkeyProvider, type PasskeyProvider } from '@/services/passkey-provider.service'

/**
 * One passkey as the API exposes it. `synced` is the backup-eligible flag:
 * the passkey can be copied to the user's other devices.
 */
export interface PublicPasskey {
  id: string
  name: string
  provider: PasskeyProvider
  synced: boolean
  createdAt: Date
  lastUsedAt: Date | null
}

/**
 * Project a passkey row for the client.
 * @param row - The passkey row.
 * @returns The public shape, with the provider named from the AAGUID.
 */
export function toPublicPasskey(row: UserPasskeyRecord): PublicPasskey {
  return {
    id: row.id,
    name: row.name,
    provider: passkeyProvider(row.aaguid),
    synced: row.backupEligible,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}
