/**
 * @file escapeLikePattern: the shared LIKE escaping for the staff searches.
 */
import { describe, expect, it } from 'vitest'
import { escapeLikePattern } from '@/utilities/like-pattern.utilities'

describe('escapeLikePattern', () => {
  it('escapes %, _ and the backslash escape character', () => {
    expect(escapeLikePattern(String.raw`50%_off\now`)).toBe(String.raw`50\%\_off\\now`)
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('ada@example.test')).toBe('ada@example.test')
  })
})
