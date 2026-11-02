/**
 * @file A role takes "a" or "an" by its first letter.
 */
import { describe, expect, it } from 'vite-plus/test'
import { roleWithArticle } from '@/utilities/role-text.utilities'

describe('roleWithArticle', () => {
  it.each([
    ['member', 'a member'],
    ['admin', 'an admin'],
    ['owner', 'an owner'],
  ])('writes %s as %s', (role, text) => {
    expect(roleWithArticle(role)).toBe(text)
  })
})
