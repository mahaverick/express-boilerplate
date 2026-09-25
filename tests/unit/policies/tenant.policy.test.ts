// tests/unit/policies/tenant.policy.test.ts
//
// The full matrix of each tenant policy. Expected values are written out
// row by row, not derived from the rules, so a change to a rule has to
// change this table too.
import { describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import { canActorGrantRole, canActorModifyTarget, isRoleAtLeast } from '@/policies/tenant.policy'

describe('isRoleAtLeast', () => {
  it.each<[MembershipRole, MembershipRole, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'manager', true],
    ['owner', 'editor', true],
    ['owner', 'viewer', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'manager', true],
    ['admin', 'editor', true],
    ['admin', 'viewer', true],
    ['manager', 'owner', false],
    ['manager', 'admin', false],
    ['manager', 'manager', true],
    ['manager', 'editor', true],
    ['manager', 'viewer', true],
    ['editor', 'owner', false],
    ['editor', 'admin', false],
    ['editor', 'manager', false],
    ['editor', 'editor', true],
    ['editor', 'viewer', true],
    ['viewer', 'owner', false],
    ['viewer', 'admin', false],
    ['viewer', 'manager', false],
    ['viewer', 'editor', false],
    ['viewer', 'viewer', true],
  ])('isRoleAtLeast(%s, %s) is %s', (role, required, expected) => {
    expect(isRoleAtLeast(role, required)).toBe(expected)
  })
})

describe('canActorModifyTarget', () => {
  it.each<[MembershipRole, MembershipRole, boolean, boolean]>([
    ['owner', 'owner', false, false],
    ['owner', 'owner', true, true],
    ['owner', 'admin', false, true],
    ['owner', 'admin', true, true],
    ['owner', 'manager', false, true],
    ['owner', 'manager', true, true],
    ['owner', 'editor', false, true],
    ['owner', 'editor', true, true],
    ['owner', 'viewer', false, true],
    ['owner', 'viewer', true, true],
    ['admin', 'owner', false, false],
    ['admin', 'owner', true, false],
    ['admin', 'admin', false, false],
    ['admin', 'admin', true, false],
    ['admin', 'manager', false, true],
    ['admin', 'manager', true, true],
    ['admin', 'editor', false, true],
    ['admin', 'editor', true, true],
    ['admin', 'viewer', false, true],
    ['admin', 'viewer', true, true],
    ['manager', 'owner', false, false],
    ['manager', 'owner', true, false],
    ['manager', 'admin', false, false],
    ['manager', 'admin', true, false],
    ['manager', 'manager', false, false],
    ['manager', 'manager', true, false],
    ['manager', 'editor', false, false],
    ['manager', 'editor', true, false],
    ['manager', 'viewer', false, false],
    ['manager', 'viewer', true, false],
    ['editor', 'owner', false, false],
    ['editor', 'owner', true, false],
    ['editor', 'admin', false, false],
    ['editor', 'admin', true, false],
    ['editor', 'manager', false, false],
    ['editor', 'manager', true, false],
    ['editor', 'editor', false, false],
    ['editor', 'editor', true, false],
    ['editor', 'viewer', false, false],
    ['editor', 'viewer', true, false],
    ['viewer', 'owner', false, false],
    ['viewer', 'owner', true, false],
    ['viewer', 'admin', false, false],
    ['viewer', 'admin', true, false],
    ['viewer', 'manager', false, false],
    ['viewer', 'manager', true, false],
    ['viewer', 'editor', false, false],
    ['viewer', 'editor', true, false],
    ['viewer', 'viewer', false, false],
    ['viewer', 'viewer', true, false],
  ])(
    'canActorModifyTarget(actor %s, target %s, isSelf %s) is %s',
    (actorRole, targetRole, isSelf, expected) => {
      expect(canActorModifyTarget(actorRole, targetRole, isSelf)).toBe(expected)
    }
  )
})

describe('canActorGrantRole', () => {
  it.each<[MembershipRole, MembershipRole, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'manager', true],
    ['owner', 'editor', true],
    ['owner', 'viewer', true],
    ['admin', 'owner', false],
    ['admin', 'admin', false],
    ['admin', 'manager', true],
    ['admin', 'editor', true],
    ['admin', 'viewer', true],
    ['manager', 'owner', false],
    ['manager', 'admin', false],
    ['manager', 'manager', false],
    ['manager', 'editor', false],
    ['manager', 'viewer', false],
    ['editor', 'owner', false],
    ['editor', 'admin', false],
    ['editor', 'manager', false],
    ['editor', 'editor', false],
    ['editor', 'viewer', false],
    ['viewer', 'owner', false],
    ['viewer', 'admin', false],
    ['viewer', 'manager', false],
    ['viewer', 'editor', false],
    ['viewer', 'viewer', false],
  ])('canActorGrantRole(actor %s, role %s) is %s', (actorRole, role, expected) => {
    expect(canActorGrantRole(actorRole, role)).toBe(expected)
  })
})
