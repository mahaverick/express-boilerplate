/**
 * @file Provider names for passkeys, looked up by AAGUID in the vendored
 * community list (`src/data/passkey-aaguids.json`; its source is recorded in
 * `src/constants/passkey.constants.ts`).
 */
import aaguids from '@/data/passkey-aaguids.json'

/**
 * A passkey's provider as the client shows it: a name and optional icons
 * (data URIs).
 */
export interface PasskeyProvider {
  name: string
  iconLight: string | null
  iconDark: string | null
}

/**
 * One entry of the vendored list.
 */
interface AaguidEntry {
  name: string
  icon_light: string | null
  icon_dark: string | null
}

const entries = new Map<string, AaguidEntry>(Object.entries(aaguids as Record<string, AaguidEntry>))

/**
 * Name the provider of a passkey.
 * @param aaguid - The authenticator's AAGUID, in any letter case.
 * @returns The listed name and icons, or `{ name: 'Passkey' }` with null icons when the list lacks it.
 */
export function passkeyProvider(aaguid: string): PasskeyProvider {
  const entry = entries.get(aaguid.toLowerCase())
  // eslint-disable-next-line unicorn/no-null -- the API's "no icon" value
  if (entry === undefined) return { name: 'Passkey', iconLight: null, iconDark: null }
  return { name: entry.name, iconLight: entry.icon_light, iconDark: entry.icon_dark }
}
