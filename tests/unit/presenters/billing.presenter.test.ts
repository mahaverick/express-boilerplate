import { describe, expect, it } from 'vite-plus/test'
import { displayName, nameOrEmail } from '@/presenters/billing.presenter'

const email = 'ada@example.test'

describe('nameOrEmail', () => {
  it('joins the first and last name', () => {
    expect(nameOrEmail({ firstName: 'Ada', lastName: 'Lovelace', email })).toBe('Ada Lovelace')
  })

  it('reads one name alone', () => {
    expect(nameOrEmail({ firstName: 'Ada', lastName: null, email })).toBe('Ada')
    expect(nameOrEmail({ firstName: null, lastName: 'Lovelace', email })).toBe('Lovelace')
  })

  it('falls back to the email when there is no name', () => {
    expect(nameOrEmail({ firstName: null, lastName: null, email })).toBe(email)
    expect(nameOrEmail({ firstName: '', lastName: '', email })).toBe(email)
  })

  it('falls back to the email when the names are only whitespace', () => {
    expect(nameOrEmail({ firstName: '  ', lastName: ' ', email })).toBe(email)
  })
})

describe('displayName', () => {
  it('stays empty with no name, for callers that word their own fallback', () => {
    expect(displayName({ firstName: null, lastName: null })).toBe('')
  })
})
