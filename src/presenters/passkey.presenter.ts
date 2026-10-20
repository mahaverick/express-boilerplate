/**
 * @file Passkey rows to their wire shape. The public key, the counters and
 * the AAGUID stay on the server; the credential ID goes out, since the owner's
 * browser already holds it.
 */
import type { UserPasskeyRecord } from '@/database/models/user-passkey.model'
import { passkeyProvider, type PasskeyProvider } from '@/services/passkey-provider.service'

/**
 * One passkey as the API exposes it. `credentialId` is base64url, as stored. `synced` is the backup-eligible flag:
 * the passkey can be copied to the user's other devices.
 */
export interface PublicPasskey {
  id: string
  credentialId: string
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
    credentialId: row.credentialId,
    name: row.name,
    provider: passkeyProvider(row.aaguid),
    synced: row.backupEligible,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}
