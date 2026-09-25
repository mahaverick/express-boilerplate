// src/services/profile.service.ts
//
// The authenticated user's own profile row, with their platform role.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { NewUser, User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { UserRepository } from '@/repositories/user.repository'
import { getPlatformMembership } from '@/services/platform.service'
import type { UpdateProfileInput } from '@/validators/profile.validators'

const userRepository = new UserRepository()

/**
 * A user row with their current platform role.
 */
export interface ProfileWithPlatformRole {
  user: User
  platformRole: MembershipRole | null
}

/**
 * The user columns a validated `PATCH /profile` body writes. `Object.hasOwn`,
 * not `!== undefined`: an omitted key leaves the column alone, an explicit
 * `null` clears it.
 * @param input - The validated body.
 * @returns Only the columns the caller supplied.
 */
function toUpdateValues(
  input: UpdateProfileInput
): Partial<Pick<NewUser, 'firstName' | 'lastName'>> {
  const values: Partial<Pick<NewUser, 'firstName' | 'lastName'>> = {}
  if (Object.hasOwn(input, 'firstName')) values.firstName = input.firstName
  if (Object.hasOwn(input, 'lastName')) values.lastName = input.lastName
  return values
}

/**
 * The user's own row.
 * @param userId - The authenticated user.
 * @returns The row and the user's platform role.
 * @throws {HttpError} 404, when the user was deleted after `requireAuth` loaded it.
 */
export async function getProfile(userId: string): Promise<ProfileWithPlatformRole> {
  const user = await userRepository.findById(userId)
  if (!user) throw new HttpError('User not found', 404)
  return { user, platformRole: await getPlatformMembership(userId) }
}

/**
 * Update the user's first or last name. A body with no recognised field
 * skips the write, so `updatedAt` is not bumped for a no-op.
 * @param userId - The authenticated user.
 * @param input - The validated PATCH body.
 * @returns The row after the update and the user's platform role.
 * @throws {HttpError} 404, when the user was deleted after `requireAuth` loaded it.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput
): Promise<ProfileWithPlatformRole> {
  const values = toUpdateValues(input)
  const hasChanges = Object.keys(values).length > 0
  const user = hasChanges
    ? await userRepository.update(userId, values)
    : await userRepository.findById(userId)
  if (!user) throw new HttpError('User not found', 404)
  return { user, platformRole: await getPlatformMembership(userId) }
}
