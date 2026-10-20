/**
 * @file A software WebAuthn authenticator for tests. It builds real
 * registration and assertion responses (the JSON a browser sends) for a
 * challenge, origin and RP ID, from a P-256 key made with `node:crypto`, so
 * `@simplewebauthn/server` verifies them for real. Attestation is `none`.
 * Nothing here ships: no dependency, no production import.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKUP_STATE = 0x10
const FLAG_ATTESTED = 0x40

/**
 * The AAGUID the vendored list names "Apple Passwords", so a test can assert a provider name.
 */
const TEST_AAGUID_SYNCED_PROVIDER = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd'

/**
 * The all-zero AAGUID that platform authenticators without attestation report; the provider list has no name for it.
 */
export const TEST_AAGUID_UNKNOWN = '00000000-0000-0000-0000-000000000000'

/**
 * How a software authenticator is built.
 */
export interface SoftwareAuthenticatorOptions {
  /**
   * The RP ID its signatures are bound to. Defaults to `localhost`.
   */
  rpId?: string
  /**
   * The origin its client data names. Defaults to `http://localhost:5173`.
   */
  origin?: string
  /**
   * The authenticator model. Defaults to `TEST_AAGUID_SYNCED_PROVIDER`.
   */
  aaguid?: string
  /**
   * The backup-eligible flag (a synced passkey). Defaults to true.
   */
  backupEligible?: boolean
  /**
   * The backup-state flag. Defaults to the backup-eligible value.
   */
  backupState?: boolean
}

/**
 * What a response may override, to build a hostile one.
 */
export interface ResponseOverrides {
  origin?: string
  rpId?: string
  isUserVerified?: boolean
  /**
   * The signature counter written into the authenticator data.
   */
  signCount?: number
  /**
   * The user handle returned on an assertion, base64url. Omit for none.
   */
  userHandle?: string
}

/**
 * A CBOR item this encoder writes.
 */
type Cbor = number | Uint8Array | string | Map<number | string, Cbor>

/**
 * Encode a CBOR head: the major type and its argument.
 * @param major - The major type, 0 to 7.
 * @param value - The unsigned argument.
 * @returns The head bytes.
 */
function head(major: number, value: number): Buffer {
  const base = major << 5
  if (value < 24) return Buffer.from([base | value])
  if (value < 256) return Buffer.from([base | 24, value])
  return Buffer.from([base | 25, value >> 8, value & 0xff])
}

/**
 * Encode the small subset of CBOR a COSE key and attestation object use.
 * @param item - An integer, bytes, text or an integer-keyed map.
 * @returns The CBOR bytes.
 */
function cbor(item: Cbor): Buffer {
  if (typeof item === 'number') {
    return item >= 0 ? head(0, item) : head(1, -1 - item)
  }
  if (typeof item === 'string') {
    const text = Buffer.from(item, 'utf8')
    return Buffer.concat([head(3, text.length), text])
  }
  if (item instanceof Uint8Array) {
    return Buffer.concat([head(2, item.length), item])
  }
  const parts: Buffer[] = [head(5, item.size)]
  for (const [key, value] of item) parts.push(cbor(key), cbor(value))
  return Buffer.concat(parts)
}

/**
 * Hash with SHA-256.
 * @param data - The bytes.
 * @returns The digest.
 */
function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

/**
 * A UUID's 16 bytes.
 * @param uuid - A UUID string.
 * @returns The bytes.
 */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

/**
 * A software authenticator holding one P-256 credential.
 */
export class SoftwareAuthenticator {
  private readonly credentialIdBytes: Buffer
  private readonly privateKey: KeyObject
  private readonly cosePublicKey: Buffer
  private readonly rpId: string
  private readonly origin: string
  private readonly aaguid: string
  private readonly backupEligible: boolean
  private readonly backupState: boolean
  /**
   * The credential ID, base64url, as a server stores it.
   */
  readonly credentialId: string

  /**
   * Make an authenticator with a fresh key and credential ID.
   * @param options - Where it signs for and what model it claims to be.
   */
  constructor(options: SoftwareAuthenticatorOptions = {}) {
    this.rpId = options.rpId ?? 'localhost'
    this.origin = options.origin ?? 'http://localhost:5173'
    this.aaguid = options.aaguid ?? TEST_AAGUID_SYNCED_PROVIDER
    this.backupEligible = options.backupEligible ?? true
    this.backupState = options.backupState ?? this.backupEligible
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    // COSE key: kty EC2, alg ES256, crv P-256, then x and y.
    this.cosePublicKey = cbor(
      new Map<number | string, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ])
    )
    this.credentialIdBytes = randomBytes(32)
    this.credentialId = this.credentialIdBytes.toString('base64url')
  }

  /**
   * The flags byte.
   * @param isAttested - Whether isAttested credential data follows.
   * @param isUserVerified - Whether the user verified.
   * @returns The byte.
   */
  private flags(isAttested: boolean, isUserVerified: boolean): number {
    let flags = FLAG_USER_PRESENT
    if (isUserVerified) flags |= FLAG_USER_VERIFIED
    if (this.backupEligible) flags |= FLAG_BACKUP_ELIGIBLE
    if (this.backupState) flags |= FLAG_BACKUP_STATE
    if (isAttested) flags |= FLAG_ATTESTED
    return flags
  }

  /**
   * The authenticator data up to and including the counter.
   * @param rpId - The RP ID to hash.
   * @param isAttested - Whether isAttested credential data follows.
   * @param isUserVerified - Whether the user verified.
   * @param signCount - The counter.
   * @returns The 37 bytes.
   */
  private baseAuthenticatorData(
    rpId: string,
    isAttested: boolean,
    isUserVerified: boolean,
    signCount: number
  ): Buffer {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(signCount)
    return Buffer.concat([
      sha256(Buffer.from(rpId, 'utf8')),
      Buffer.from([this.flags(isAttested, isUserVerified)]),
      counter,
    ])
  }

  /**
   * The registration response a browser would send for `navigator.credentials.create`.
   * @param challenge - The challenge from the options, base64url.
   * @param overrides - Values to get wrong on purpose.
   * @returns The `RegistrationResponseJSON`.
   */
  registrationResponse(challenge: string, overrides: ResponseOverrides = {}): RegistrationJson {
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      })
    )
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialIdBytes.length)
    const authenticatorData = Buffer.concat([
      this.baseAuthenticatorData(
        overrides.rpId ?? this.rpId,
        true,
        overrides.isUserVerified ?? true,
        overrides.signCount ?? 0
      ),
      uuidBytes(this.aaguid),
      idLength,
      this.credentialIdBytes,
      this.cosePublicKey,
    ])
    const attestationObject = cbor(
      new Map<number | string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authenticatorData],
      ])
    )
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal', 'hybrid'],
      },
    }
  }

  /**
   * The assertion response a browser would send for `navigator.credentials.get`.
   * @param challenge - The challenge from the options, base64url.
   * @param overrides - Values to get wrong on purpose.
   * @returns The `AuthenticationResponseJSON`.
   */
  assertionResponse(challenge: string, overrides: ResponseOverrides = {}): AssertionJson {
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      })
    )
    const authenticatorData = this.baseAuthenticatorData(
      overrides.rpId ?? this.rpId,
      false,
      overrides.isUserVerified ?? true,
      overrides.signCount ?? 0
    )
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientData)]),
      this.privateKey
    )
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(overrides.userHandle !== undefined && { userHandle: overrides.userHandle }),
      },
    }
  }
}

/**
 * The JSON of a registration a browser sends.
 */
export interface RegistrationJson {
  id: string
  rawId: string
  type: 'public-key'
  clientExtensionResults: Record<string, never>
  response: { clientDataJSON: string; attestationObject: string; transports: string[] }
}

/**
 * The JSON of an assertion a browser sends.
 */
export interface AssertionJson {
  id: string
  rawId: string
  type: 'public-key'
  clientExtensionResults: Record<string, never>
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string
  }
}
