/**
 * @file A pending invitation row written directly, for analytics tests that
 * only need one to exist for an address.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from '@/services/database.service'

/**
 * Insert a pending, unexpired viewer invitation for an address.
 * @param tenantId - The inviting tenant; deleting it cascades to the row.
 * @param email - The invited address, stored as given.
 * @param invitedBy - The inviter.
 * @returns Resolves once the row exists.
 */
export async function createInvitationRow(
  tenantId: string,
  email: string,
  invitedBy: string
): Promise<void> {
  await sql`
    insert into tenant_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${randomUUID()}, ${tenantId}, ${email}, 'viewer', ${randomBytes(32).toString('hex')},
      ${invitedBy}, now() + interval '1 day')`
}
