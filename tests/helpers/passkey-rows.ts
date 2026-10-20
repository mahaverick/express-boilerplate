/**
 * @file Direct `user_passkeys` rows for tests that need a passkey on an
 * account without going through the registration routes.
 */
import { randomUUID } from 'node:crypto'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'

const repository = new UserPasskeyRepository()

/**
 * Store one passkey row for a user.
 * @param userId - The owner.
 * @returns Resolves once the row exists.
 */
export async function seedPasskey(userId: string): Promise<void> {
  await repository.create({
    userId,
    credentialId: `cred-${randomUUID()}`,
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 0,
    transports: [],
    aaguid: '00000000-0000-0000-0000-000000000000',
    backupEligible: true,
    backupState: false,
    name: 'Seeded',
  })
}

/**
 * How many passkeys a user holds.
 * @param userId - The owner.
 * @returns The count.
 */
export function passkeyCount(userId: string): Promise<number> {
  return repository.countByUser(userId)
}
