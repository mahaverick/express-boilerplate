// tests/unit/utilities/password.utilities.test.ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BCRYPT_COST, MAX_PASSWORD_BYTES } from '@/constants/auth.constants'
import { hashPassword, isPasswordValid } from '@/utilities/password.utilities'

describe('password hashing', () => {
  it('produces a verifiable hash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await isPasswordValid('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right')
    expect(await isPasswordValid('wrong', hash)).toBe(false)
  })

  it('salts — the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('uses the configured cost, so a weakened cost fails the build', async () => {
    const hash = await hashPassword('x')
    expect(hash.split('$', 3)[2]).toBe(String(BCRYPT_COST).padStart(2, '0'))
  })

  it("never drops below OWASP's floor for bcrypt", () => {
    // A guard on the CONSTANT's value, not just its wiring: the test above
    // only proves hashPassword uses whatever BCRYPT_COST is set to — it
    // still passes if someone quietly weakens the constant itself. This is
    // the one that stops that.
    expect(BCRYPT_COST).toBeGreaterThanOrEqual(12)
  })

  it("SECURITY.md's stated bcrypt cost agrees with BCRYPT_COST", () => {
    // Reads the committed file off disk rather than asserting on BCRYPT_COST
    // alone — the failure this guards against is the doc and the constant
    // drifting apart, which a self-referential assertion cannot catch. Same
    // technique as tests/unit/connection-target.test.ts.
    const securityDocument = fs.readFileSync(path.resolve(process.cwd(), 'SECURITY.md'), 'utf8')
    const match = /^### Password hashing: bcrypt at cost (\d+)/m.exec(securityDocument)

    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(BCRYPT_COST)
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await isPasswordValid('x', 'not-a-bcrypt-hash')).toBe(false)
  })

  it('rejects a password over the bcrypt byte limit instead of silently truncating it', async () => {
    // Two passwords sharing the same first MAX_PASSWORD_BYTES bytes would
    // otherwise hash identically under bcrypt's own silent truncation —
    // this is the regression that guard exists to prevent.
    const overLong = 'a'.repeat(MAX_PASSWORD_BYTES + 1)
    await expect(hashPassword(overLong)).rejects.toThrow()
  })

  it('does not leak the exact byte limit in the rejection message', async () => {
    const overLong = 'a'.repeat(MAX_PASSWORD_BYTES + 1)
    let thrown: unknown
    try {
      await hashPassword(overLong)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).not.toContain(String(MAX_PASSWORD_BYTES))
  })

  it('treats an over-length login attempt as a failed match, without ever calling bcrypt', async () => {
    const hash = await hashPassword('short')
    const overLong = 'a'.repeat(MAX_PASSWORD_BYTES + 1)
    expect(await isPasswordValid(overLong, hash)).toBe(false)
  })

  it('measures length in UTF-8 bytes, not characters — a multi-byte password near the limit is still rejected', async () => {
    // '💥' is 4 bytes in UTF-8; repeating it comfortably clears
    // MAX_PASSWORD_BYTES in bytes while staying short in character count,
    // so this would only fail if the guard counted .length instead.
    const multiByteOverLong = '💥'.repeat(Math.ceil(MAX_PASSWORD_BYTES / 4) + 1)
    expect(Buffer.byteLength(multiByteOverLong, 'utf8')).toBeGreaterThan(MAX_PASSWORD_BYTES)
    await expect(hashPassword(multiByteOverLong)).rejects.toThrow()
  })

  it('logs at error level and still returns false when the comparison itself throws', async () => {
    // bcrypt.compare only throws for a non-string/null/undefined hash, not
    // for a malformed-but-string one (see password.utilities.ts) — this
    // exercises that throwing path directly, without depending on bcrypt's
    // internal behaviour for any particular string.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await isPasswordValid('x', undefined as unknown as string)).toBe(false)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
