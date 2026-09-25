// src/scripts/platform-grant.ts
//
// `pnpm platform:grant -- <email> <role>`: give an existing, verified user a
// role in the platform tenant, audited as a system grant. The way to make
// the first platform owner, since nobody can invite before one exists.
// Prints the outcome only; never a token or a hash.
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'
import { closeDatabase } from '@/services/database.service'
import { bootstrapGrant } from '@/services/platform.service'
import { emailSchema } from '@/validators/auth.validators'

const USAGE = 'Usage: pnpm platform:grant -- <email> <role>'
const roleSchema = z.enum(MEMBERSHIP_ROLES)

/**
 * The script's validated arguments.
 */
export interface GrantArguments {
  email: string
  role: MembershipRole
}

/**
 * Read `<email> <role>` from the command line, ignoring pnpm's `--`.
 * @param argv - The arguments after the script path.
 * @returns The normalised email and the role.
 * @throws {Error} The usage line for a missing, extra or malformed argument; a list of the allowed roles for an unknown role.
 */
export function parseGrantArguments(argv: readonly string[]): GrantArguments {
  const [email, role, ...extra] = argv.filter((argument) => argument !== '--')
  const parsedEmail = emailSchema.safeParse(email)
  if (role === undefined || extra.length > 0 || !parsedEmail.success) throw new Error(USAGE)
  const parsedRole = roleSchema.safeParse(role)
  if (!parsedRole.success) {
    throw new Error(`Unknown role "${role}". Use one of: ${MEMBERSHIP_ROLES.join(', ')}`)
  }
  return { email: parsedEmail.data, role: parsedRole.data }
}

/**
 * Parse the arguments and grant the role, printing the outcome.
 * @param argv - The arguments after the script path.
 * @returns The process exit code: 0 on success, 1 on any failure.
 */
export async function runPlatformGrant(argv: readonly string[]): Promise<number> {
  try {
    const { email, role } = parseGrantArguments(argv)
    const membership = await bootstrapGrant(email, role)
    process.stdout.write(`Granted ${membership.role} in the platform tenant to ${email}.\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// Only when run directly, never when a test imports this module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPlatformGrant(process.argv.slice(2))
  await closeDatabase()
}
