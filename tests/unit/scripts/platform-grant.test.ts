// tests/unit/scripts/platform-grant.test.ts
//
// Argument parsing for `pnpm platform:grant -- <email> <role>`. Importing
// the script does not run it: it acts only when it is the entry module.
import { describe, expect, it } from 'vitest'
import { parseGrantArguments } from '@/scripts/platform-grant'

describe('parseGrantArguments', () => {
  it('reads the email and role after the pnpm separator, lowercasing the email', () => {
    expect(parseGrantArguments(['--', ' Staff@Example.com ', 'admin'])).toEqual({
      email: 'staff@example.com',
      role: 'admin',
    })
  })

  it('works without the separator', () => {
    expect(parseGrantArguments(['staff@example.com', 'owner'])).toEqual({
      email: 'staff@example.com',
      role: 'owner',
    })
  })

  it('refuses a role outside MEMBERSHIP_ROLES, naming the allowed ones', () => {
    expect(() => parseGrantArguments(['staff@example.com', 'superuser'])).toThrow(
      'Unknown role "superuser". Use one of: owner, admin, manager, editor, viewer'
    )
  })

  it.each([
    [['staff@example.com']],
    [['not-an-email', 'admin']],
    [['staff@example.com', 'admin', 'extra']],
    [[]],
  ])('prints usage for %j', (argv) => {
    expect(() => parseGrantArguments(argv)).toThrow('Usage: pnpm platform:grant -- <email> <role>')
  })
})
