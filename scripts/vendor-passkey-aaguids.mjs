/**
 * @file Rebuilds src/data/passkey-aaguids.json from the community list's
 * `combined_aaguid.json`. Usage: node scripts/vendor-passkey-aaguids.mjs
 * <combined_aaguid.json> <commit> [fetchedAt]. The input is only parsed as
 * data, never run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The repository the list comes from.
 */
const SOURCE_REPO = 'passkeydeveloper/passkey-authenticator-aaguids'

/**
 * The longest icon data URI kept; a longer one is stored as null.
 */
export const MAX_ICON_LENGTH = 30_000

/**
 * Deduplicate the list's icons into one table.
 * @param combined - The parsed `combined_aaguid.json`: AAGUID to `{ name, icon_light, icon_dark }`.
 * @param source - Where the list came from.
 * @returns The vendored shape: `source`, `icons`, and `entries` whose `light` and `dark` index `icons` or are null.
 */
export function dedupeAaguids(combined, source) {
  const icons = []
  const indexes = new Map()
  /**
   * Index an icon, adding it when new; an absent or oversized icon is null.
   * @param uri - The icon data URI.
   * @returns The index into `icons`, or null.
   */
  const indexOf = (uri) => {
    if (typeof uri !== 'string' || uri === '' || uri.length > MAX_ICON_LENGTH) return null
    let index = indexes.get(uri)
    if (index === undefined) {
      index = icons.length
      icons.push(uri)
      indexes.set(uri, index)
    }
    return index
  }
  const entries = {}
  for (const [aaguid, value] of Object.entries(combined)) {
    entries[aaguid.toLowerCase()] = {
      name: String(value.name),
      light: indexOf(value.icon_light),
      dark: indexOf(value.icon_dark),
    }
  }
  return { source, icons, entries }
}

/**
 * Run the CLI: read the input path, write the vendored file.
 */
function main() {
  const [input, commit, fetchedAt = new Date().toISOString().slice(0, 10)] = process.argv.slice(2)
  if (!input || !commit) {
    console.error('usage: vendor-passkey-aaguids.mjs <combined_aaguid.json> <commit> [fetchedAt]')
    process.exitCode = 1
    return
  }
  const combined = JSON.parse(readFileSync(input, 'utf8'))
  const data = dedupeAaguids(combined, { repo: SOURCE_REPO, commit, fetchedAt })
  const target = new URL('../src/data/passkey-aaguids.json', import.meta.url)
  writeFileSync(target, JSON.stringify(data))
  console.log(`wrote ${Object.keys(data.entries).length} entries, ${data.icons.length} icons`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
