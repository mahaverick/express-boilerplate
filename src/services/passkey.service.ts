/**
 * @file A signed-in user's passkeys: list, create (registration options, then
 * verify), rename and delete. A write holds the user row lock, so the 20-passkey
 * cap and the required-mode "keep one" rule see a stable count. The audit row
 * goes in the write's transaction, on the platform tenant, with the passkey's row
 * id and provider name and never the credential ID; the security mail goes out
 * after commit and never fails the request.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { getEnv } from '@/configs/env.config'
import { passkeyRelyingParty } from '@/configs/passkey.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { UserPasskeyRecord } from '@/database/models/user-passkey.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { addEmailJob } from '@/jobs/email.job'
import type { AuthenticatedUser } from '@/presenters/user.presenter'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import { buildSecuritySettingsUrl } from '@/services/link-token.service'
import { logger } from '@/services/logger.service'
import {
  consumePasskeyChallenge,
  issuePasskeyChallenge,
} from '@/services/passkey-challenge.service'
import { passkeyProvider } from '@/services/passkey-provider.service'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { PASSKEY_NAME_MAX_LENGTH } from '@/validators/passkey.validators'

const userRepository = new UserRepository()
const userPasskeyRepository = new UserPasskeyRepository()
const tenantRepository = new TenantRepository()

/**
 * The most passkeys one account can hold.
 */
const MAX_PASSKEYS_PER_USER = 20

/**
 * The code of a refused create at the cap.
 */
const PASSKEY_LIMIT_CODE = 'PASSKEY_LIMIT'

/**
 * The code of a refused delete of the last passkey in required mode.
 */
const LAST_PASSKEY_CODE = 'LAST_PASSKEY'

/**
 * The code of a registration that did not verify.
 */
const PASSKEY_VERIFICATION_FAILED_CODE = 'PASSKEY_VERIFICATION_FAILED'

/**
 * The 400 for a registration that did not verify. One answer for a replayed,
 * expired, cross-user or cross-purpose challenge and for a response that fails
 * the check, so a caller learns nothing about which.
 * @returns The error to throw.
 */
function passkeyVerificationFailed(): HttpError {
  return new HttpError(
    "We couldn't confirm this passkey. Try again, or use another method.",
    400,
    PASSKEY_VERIFICATION_FAILED_CODE
  )
}

/**
 * The 409 for a create at the cap.
 * @returns The error to throw.
 */
function passkeyLimitReached(): HttpError {
  return new HttpError(
    `You have ${String(MAX_PASSKEYS_PER_USER)} passkeys, the most an account can hold. Delete one to create another.`,
    409,
    PASSKEY_LIMIT_CODE
  )
}

/**
 * Every passkey a user has, oldest first.
 * @param userId - The owner.
 * @returns The rows.
 */
export async function listPasskeys(userId: string): Promise<UserPasskeyRecord[]> {
  return userPasskeyRepository.listByUser(userId)
}

/**
 * A user's UUID as the 16 bytes that are their WebAuthn user handle.
 * @param userId - The user's UUID.
 * @returns The bytes.
 */
function userHandleBytes(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId.replaceAll('-', ''), 'hex'))
}

/**
 * Refuse a create when the user already holds the cap.
 * @param userId - The owner.
 * @param executor - Where to count; a transaction holding the user lock makes it exact.
 * @throws {HttpError} 409 `PASSKEY_LIMIT` at 20.
 */
async function assertBelowLimit(userId: string, executor?: DbTransaction): Promise<void> {
  const total = await userPasskeyRepository.countByUser(userId, executor)
  if (total >= MAX_PASSKEYS_PER_USER) throw passkeyLimitReached()
}

/**
 * Start a registration: issue a single-use challenge bound to the user and
 * build the WebAuthn options. The options ask for a resident key with user
 * verification and no attestation, and exclude the user's own credentials.
 * @param user - The signed-in user.
 * @returns The challenge id for the verify call, and the options for the browser.
 * @throws {HttpError} 409 `PASSKEY_LIMIT` at 20 passkeys.
 */
export async function startPasskeyRegistration(
  user: AuthenticatedUser
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  await assertBelowLimit(user.id)
  const existing = await userPasskeyRepository.listByUser(user.id)
  const rp = passkeyRelyingParty()
  const { challengeId, challenge } = await issuePasskeyChallenge('create', { userId: user.id })
  const fullName = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userName: user.email,
    userDisplayName: fullName === '' ? user.email : fullName,
    userID: userHandleBytes(user.id),
    // The stored challenge is already base64url; decode it so the options carry it unchanged.
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: row.transports as never,
    })),
  })
  return { challengeId, options }
}

/**
 * The name a new passkey gets: the provider's name, or "<name> 2", "<name> 3"
 * and so on when the user already has that name. Cut to fit the column.
 * @param providerName - The provider's listed name.
 * @param taken - The names the user already has.
 * @returns A name no other passkey of the user has.
 */
function defaultPasskeyName(providerName: string, taken: readonly string[]): string {
  const used = new Set(taken)
  const base = providerName.slice(0, PASSKEY_NAME_MAX_LENGTH)
  if (!used.has(base)) return base
  for (let number = 2; ; number += 1) {
    const suffix = ` ${String(number)}`
    const candidate = `${providerName.slice(0, PASSKEY_NAME_MAX_LENGTH - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Tell the user about a passkey change by mail, after commit. A failure is
 * logged, not thrown: the change has happened and cannot be undone.
 * @param user - The signed-in user.
 * @param templateKey - Which security mail.
 * @param providerName - The passkey's provider.
 * @param app - The frontend the request came from.
 * @returns Resolves once the job is queued or the failure is logged.
 */
async function sendPasskeyNotice(
  user: AuthenticatedUser,
  templateKey: 'passkey_created' | 'passkey_deleted',
  providerName: string,
  app: FrontendApp
): Promise<void> {
  try {
    await addEmailJob(
      {
        to: user.email.toLowerCase(),
        templateKey,
        variables: {
          firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
          providerName,
          occurredAt: formatUtcDateTime(new Date()),
          settingsUrl: buildSecuritySettingsUrl(app, templateKey),
          appName: appNameFor(app),
        },
      },
      user.id,
      { context: { linkApp: app } }
    )
  } catch (error) {
    logger.warn('A passkey security mail could not be queued', { templateKey, error })
  }
}

/**
 * Lock the user row, so the count and the write that follows are exact.
 * @param userId - The user.
 * @param tx - The transaction.
 * @throws {HttpError} 401 when the account is gone or inactive.
 */
async function lockUser(userId: string, tx: DbTransaction): Promise<void> {
  const locked = await userRepository.lockById(userId, 'no key update', tx)
  if (!locked?.active) throw new HttpError('Sign in to continue.', 401)
}

/**
 * The platform tenant, where every passkey audit row goes.
 * @param tx - The transaction.
 * @returns Its id.
 * @throws {Error} When the platform tenant is missing.
 */
async function platformTenantId(tx: DbTransaction): Promise<string> {
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new Error('The platform tenant is missing')
  return platform.id
}

/**
 * Finish a registration: consume the challenge, verify the browser's response
 * against the relying party, then store the passkey, audit it and mail the user.
 * @param user - The signed-in user.
 * @param input - The challenge id, the browser's response and the frontend.
 * @param input.challengeId - The id the options call answered.
 * @param input.response - The browser's registration response.
 * @param input.app - The frontend the request came from.
 * @returns The stored row.
 * @throws {HttpError} 400 `PASSKEY_VERIFICATION_FAILED` for a challenge that is missing, used, expired or not the caller's, and for a response that does not verify; 409 `PASSKEY_LIMIT` at 20 passkeys.
 */
export async function finishPasskeyRegistration(
  user: AuthenticatedUser,
  input: { challengeId: string; response: unknown; app: FrontendApp }
): Promise<UserPasskeyRecord> {
  const challenge = await consumePasskeyChallenge(input.challengeId, 'create', {
    userId: user.id,
  })
  if (challenge === undefined) throw passkeyVerificationFailed()
  const rp = passkeyRelyingParty()
  const response = input.response as RegistrationResponseJSON
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    })
  } catch {
    throw passkeyVerificationFailed()
  }
  if (!verified.verified) throw passkeyVerificationFailed()
  const { aaguid, credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo
  const provider = passkeyProvider(aaguid)
  const created = await withTransaction(async (tx) => {
    await lockUser(user.id, tx)
    await assertBelowLimit(user.id, tx)
    const existing = await userPasskeyRepository.listByUser(user.id, tx)
    const taken = existing.map((row) => row.name)
    const row = await userPasskeyRepository.create(
      {
        userId: user.id,
        credentialId: credential.id,
        publicKey: credential.publicKey,
        signCount: credential.counter,
        transports: response.response.transports ?? credential.transports ?? [],
        aaguid,
        backupEligible: credentialDeviceType === 'multiDevice',
        backupState: credentialBackedUp,
        name: defaultPasskeyName(provider.name, taken),
      },
      tx
    )
    await record(
      {
        action: 'user.passkey_created',
        actor: { userId: user.id },
        access: 'member',
        tenantId: await platformTenantId(tx),
        targetId: user.id,
        metadata: { passkeyId: row.id, provider: provider.name.slice(0, 100), app: input.app },
      },
      tx
    )
    return row
  })
  await sendPasskeyNotice(user, 'passkey_created', provider.name, input.app)
  return created
}

/**
 * Rename a passkey the user owns.
 * @param userId - The caller.
 * @param passkeyId - The passkey's row id.
 * @param name - The new name, already trimmed and bounded.
 * @returns The updated row.
 * @throws {HttpError} 404 when the user owns no such passkey.
 */
export async function renamePasskey(
  userId: string,
  passkeyId: string,
  name: string
): Promise<UserPasskeyRecord> {
  const row = await userPasskeyRepository.rename(passkeyId, userId, name)
  if (row === undefined) throw notFoundError('passkey')
  return row
}

/**
 * Delete a passkey the user owns, audit it and mail the user. In required mode
 * the last passkey stays.
 * @param user - The signed-in user.
 * @param passkeyId - The passkey's row id.
 * @param app - The frontend the request came from.
 * @returns The passkeys the user has left.
 * @throws {HttpError} 404 when the user owns no such passkey; 409 `LAST_PASSKEY` in required mode with one passkey left.
 */
export async function deletePasskey(
  user: AuthenticatedUser,
  passkeyId: string,
  app: FrontendApp
): Promise<UserPasskeyRecord[]> {
  const { removed, remaining } = await withTransaction(async (tx) => {
    await lockUser(user.id, tx)
    const all = await userPasskeyRepository.listByUser(user.id, tx)
    if (all.every((row) => row.id !== passkeyId)) throw notFoundError('passkey')
    if (getEnv().PASSKEY_MODE === 'required' && all.length <= 1) {
      throw new HttpError(
        'Create another passkey before you delete this one. Your account needs at least one.',
        409,
        LAST_PASSKEY_CODE
      )
    }
    const deleted = await userPasskeyRepository.deleteForUser(passkeyId, user.id, tx)
    if (deleted === undefined) throw notFoundError('passkey')
    const provider = passkeyProvider(deleted.aaguid)
    await record(
      {
        action: 'user.passkey_deleted',
        actor: { userId: user.id },
        access: 'member',
        tenantId: await platformTenantId(tx),
        targetId: user.id,
        metadata: { passkeyId: deleted.id, provider: provider.name.slice(0, 100), app },
      },
      tx
    )
    return { removed: provider.name, remaining: all.filter((row) => row.id !== passkeyId) }
  })
  await sendPasskeyNotice(user, 'passkey_deleted', removed, app)
  return remaining
}
