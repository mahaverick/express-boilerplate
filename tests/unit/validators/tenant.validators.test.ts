// tests/unit/validators/tenant.validators.test.ts
import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS } from '@/constants/tenant.constants'
import { slugSchema } from '@/validators/tenant.validators'

describe('slugSchema', () => {
  it('reserves the seeded platform tenant’s slug', () => {
    expect(RESERVED_SLUGS).toContain('platform')
    expect(slugSchema.safeParse('platform').success).toBe(false)
  })

  it('still accepts an ordinary slug', () => {
    expect(slugSchema.safeParse('platform-team').success).toBe(true)
  })
})
