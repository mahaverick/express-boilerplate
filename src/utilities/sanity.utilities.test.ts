import { describe, expect, it } from 'vitest'
import { identity } from '@/utilities/sanity.utilities'

describe('identity', () => {
  it('returns its argument', () => {
    expect(identity('x')).toBe('x')
  })
})
