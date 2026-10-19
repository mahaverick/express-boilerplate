/**
 * @file Where a frontend may send someone after a sign-in link: a path on
 * its own origin, stored and handed back byte for byte. Anything a browser
 * could resolve to another origin is refused, never rewritten.
 */
import { z } from 'zod'
import { MAX_REDIRECT_PATH_LENGTH } from '@/constants/auth.constants'

/**
 * A placeholder origin the path is resolved against; a value that resolves
 * anywhere else would leave the frontend.
 */
const PROBE_ORIGIN = 'https://frontend.invalid'

/**
 * Whether a value contains a backslash, a C0 control character or DEL.
 * Browsers read a backslash as a slash and drop tabs and newlines from a
 * URL, so either can turn a path into another origin.
 * @param value - The candidate path.
 * @returns True when any such character is present.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    if (character === '\\') return true
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7f || code < 0x20) return true
  }
  return false
}

/**
 * Whether a path resolves on the origin it is joined to.
 * @param value - The candidate path.
 * @returns True when the probe origin is unchanged.
 */
function isOnProbeOrigin(value: string): boolean {
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN
  } catch {
    return false
  }
}

/**
 * A same-origin redirect path, with any query and fragment: 1 to
 * `MAX_REDIRECT_PATH_LENGTH` characters, starting with one `/` not followed
 * by `/` or `\`, with no backslash or control character, resolving on the
 * frontend's own origin. The input is returned unchanged.
 */
export const redirectPathSchema: z.ZodType<string> = z
  .string()
  .min(1)
  .max(MAX_REDIRECT_PATH_LENGTH)
  .refine((value) => value.startsWith('/') && value[1] !== '/' && value[1] !== '\\', {
    message: 'Must be a path on this site, starting with a single /',
  })
  .refine((value) => !hasUnsafeCharacter(value), {
    message: 'Must not contain a backslash or a control character',
  })
  .refine(isOnProbeOrigin, { message: 'Must stay on this site' })
