/**
 * @file Provider names for passkeys, looked up by AAGUID in the vendored
 * community list (`src/data/passkey-aaguids.json`; its source and refresh
 * steps are in `src/constants/passkey.constants.ts`). The file is read with
 * `readFileSync`, not imported: a compiled ESM JSON import needs an import
 * attribute that Node 24 rejects without one.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * A passkey's provider as the client shows it: a name and optional icons
 * (data URIs).
 */
export interface PasskeyProvider {
  name: string
  iconLight: string | null
  iconDark: string | null
}

const iconIndexSchema = z.number().int().nonnegative().nullable()
const entrySchema = z.object({
  name: z.string(),
  light: iconIndexSchema,
  dark: iconIndexSchema,
})
const sourceSchema = z.object({ repo: z.string(), commit: z.string(), fetchedAt: z.string() })
const aaguidDataSchema = z.object({
  source: sourceSchema,
  icons: z.array(z.string()),
  entries: z.record(z.string(), entrySchema),
})

/**
 * Validate the vendored data and build the lookup over it.
 * @param data - The parsed JSON: `{ source, icons, entries }`, where an entry's `light` and `dark` index `icons`.
 * @returns A function from an AAGUID to its provider.
 * @throws {Error} When the data has the wrong shape or an icon index is out of range.
 */
export function createPasskeyProviderLookup(data: unknown): (aaguid: string) => PasskeyProvider {
  const parsed = aaguidDataSchema.parse(data)
  /**
   * Resolve an icon index.
   * @param index - An index into the icon table, or null.
   * @returns The data URI, or null.
   */
  const icon = (index: number | null): string | null => {
    if (index === null) return null
    const uri = parsed.icons[index]
    if (uri === undefined)
      throw new Error(`Passkey AAGUID data: icon index ${String(index)} is out of range`)
    return uri
  }
  const entries = new Map<string, PasskeyProvider>()
  for (const [aaguid, entry] of Object.entries(parsed.entries)) {
    entries.set(aaguid.toLowerCase(), {
      name: entry.name,
      iconLight: icon(entry.light),
      iconDark: icon(entry.dark),
    })
  }
  return (aaguid) => {
    const entry = entries.get(aaguid.toLowerCase())
    return entry ?? { name: 'Passkey', iconLight: null, iconDark: null }
  }
}

const rawData = readFileSync(new URL('../data/passkey-aaguids.json', import.meta.url), 'utf8')
const lookup = createPasskeyProviderLookup(JSON.parse(rawData))

/**
 * Name the provider of a passkey.
 * @param aaguid - The authenticator's AAGUID, in any letter case.
 * @returns The listed name and icons, or `{ name: 'Passkey' }` with null icons when the list lacks it.
 */
export function passkeyProvider(aaguid: string): PasskeyProvider {
  return lookup(aaguid)
}
