/**
 * @file Workspace insights, the reference Paid feature: who joined a
 * workspace and how many invitations it sent in the last 30 days. Its route
 * sits behind `requireFeature('advanced_example')`.
 */
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'

const invitationRepository = new TenantInvitationRepository()
const membershipRepository = new UserMembershipRepository()

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A workspace's activity over the last 30 days.
 */
export interface WorkspaceInsights {
  /**
   * Memberships that began in the window, current members only.
   */
  membersJoinedLast30Days: number
  /**
   * Invitations sent in the window, whatever became of them.
   */
  invitationsSentLast30Days: number
}

/**
 * Count a workspace's joins and invitations over the last 30 days.
 * @param tenantId - The workspace.
 * @param now - The current time.
 * @returns The two counts.
 */
export async function getWorkspaceInsights(
  tenantId: string,
  now = new Date()
): Promise<WorkspaceInsights> {
  const since = new Date(now.getTime() - WINDOW_MS)
  const [membersJoinedLast30Days, invitationsSentLast30Days] = await Promise.all([
    membershipRepository.countJoinedSince(tenantId, since),
    invitationRepository.countCreatedSince(tenantId, since),
  ])
  return { membersJoinedLast30Days, invitationsSentLast30Days }
}
