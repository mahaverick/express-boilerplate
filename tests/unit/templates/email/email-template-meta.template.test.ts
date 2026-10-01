/**
 * @file The template registry's tracking metadata, pinned per template, and
 * the two guards on it: every template whose variables carry a secret uses
 * the transactional sender, and no secret-named variable is ever listed for
 * storage (a compile error in the template module, and a thrown error at
 * module load for anything that gets past the type).
 */
import { describe, expect, it } from 'vitest'
import { SECRET_VARIABLE_PATTERN } from '@/constants/email.constants'
import type { MailMessage } from '@/services/mailer.service'
import {
  assertTemplateMetaSafe,
  EMAIL_TEMPLATE_META,
} from '@/templates/email/email-template-meta.template'
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
  type EmailTemplateMeta,
} from '@/utilities/email-template.utilities'

/**
 * One real variables object per template. Typed from `MailMessage`, so a
 * template whose variables change fails to compile here until this changes.
 */
const SAMPLE_VARIABLES: {
  [K in EmailTemplateKey]: Extract<MailMessage, { templateKey: K }>['variables']
} = {
  email_verification: { firstName: 'Ada', verificationUrl: 'https://x.test/v', appName: 'App' },
  password_reset: { firstName: 'Ada', resetUrl: 'https://x.test/r', appName: 'App' },
  registration_attempt: { firstName: 'Ada', appName: 'App' },
  password_changed: { firstName: 'Ada', appName: 'App' },
  tenant_invitation: {
    tenantName: 'Acme',
    inviterName: 'Grace',
    role: 'viewer',
    acceptUrl: 'https://x.test/a',
    expiresInDays: '7',
    appName: 'App',
  },
  account_setup: { firstName: 'Ada', setupUrl: 'https://x.test/s', appName: 'App' },
}

describe('EMAIL_TEMPLATE_META', () => {
  it('covers every template key', () => {
    expect(Object.keys(EMAIL_TEMPLATE_META).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...EMAIL_TEMPLATE_KEYS].toSorted((a, b) => a.localeCompare(b))
    )
  })

  it('pins each template to the spec', () => {
    expect(EMAIL_TEMPLATE_META).toEqual({
      email_verification: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'appName'],
        resendAction: 'verification',
      },
      password_reset: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'appName'],
        resendAction: 'password_setup',
      },
      account_setup: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'appName'],
        resendAction: 'password_setup',
      },
      tenant_invitation: {
        senderClass: 'transactional',
        previewVariables: ['tenantName', 'role', 'expiresInDays', 'appName'],
        resendAction: 'invitation',
      },
      password_changed: {
        senderClass: 'general',
        previewVariables: ['firstName', 'appName'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      registration_attempt: {
        senderClass: 'general',
        previewVariables: ['firstName', 'appName'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
    })
  })

  it.each(EMAIL_TEMPLATE_KEYS)(
    '%s uses the transactional sender exactly when its variables carry a secret',
    (key) => {
      const hasSecret = Object.keys(SAMPLE_VARIABLES[key]).some((name) =>
        SECRET_VARIABLE_PATTERN.test(name)
      )
      expect(EMAIL_TEMPLATE_META[key].senderClass).toBe(hasSecret ? 'transactional' : 'general')
    }
  )

  it.each(EMAIL_TEMPLATE_KEYS)('%s stores only variables the template really has', (key) => {
    const names = Object.keys(SAMPLE_VARIABLES[key])
    const stored = EMAIL_TEMPLATE_META[key].previewVariables
    for (const name of stored) expect(names).toContain(name)
  })

  it('never stores the inviter name, another person the invitation names', () => {
    expect(EMAIL_TEMPLATE_META.tenant_invitation.previewVariables).not.toContain('inviterName')
  })

  it('offers no resend for the two security notices', () => {
    expect(EMAIL_TEMPLATE_META.password_changed.resendAction).toBeNull()
    expect(EMAIL_TEMPLATE_META.registration_attempt.resendAction).toBeNull()
  })
})

describe('assertTemplateMetaSafe', () => {
  it('passes the real registry, which it already checked when the module loaded', () => {
    expect(assertTemplateMetaSafe(EMAIL_TEMPLATE_META)).toBe(EMAIL_TEMPLATE_META)
  })

  it.each(['resetUrl', 'refreshToken'])('refuses a stored variable named %s', (name) => {
    const registry = {
      password_reset: {
        senderClass: 'transactional' as const,
        previewVariables: ['firstName', name],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
    }
    expect(() => {
      assertTemplateMetaSafe(registry)
    }).toThrow(`"password_reset" lists "${name}"`)
  })
})

/**
 * Compile-time only: `tsc` (run by `pnpm lint`) reports an unused
 * `@ts-expect-error` if a rule stops holding. The runtime `expect`s only
 * keep each literal a real, read value.
 */
describe('EmailTemplateMeta type rules', () => {
  interface TokenVariables {
    firstName: string
    resetUrl: string
  }
  interface PlainVariables {
    firstName: string
  }

  it('refuses the general sender for variables that carry a secret', () => {
    const meta: EmailTemplateMeta<TokenVariables> = {
      // @ts-expect-error -- a template with a …Url variable must mail from the transactional sender
      senderClass: 'general',
      previewVariables: ['firstName'],
      resendAction: 'password_setup',
    }
    expect(meta.senderClass).toBe('general')
  })

  it('refuses to list a secret variable for storage', () => {
    const meta: EmailTemplateMeta<TokenVariables> = {
      senderClass: 'transactional',
      // @ts-expect-error -- resetUrl carries a token and may never be stored
      previewVariables: ['firstName', 'resetUrl'],
      resendAction: 'password_setup',
    }
    expect(meta.previewVariables).toHaveLength(2)
  })

  it('refuses the transactional sender for variables with no secret', () => {
    const meta: EmailTemplateMeta<PlainVariables> = {
      // @ts-expect-error -- the general sender is the one for token-free templates
      senderClass: 'transactional',
      previewVariables: ['firstName'],
      // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
      resendAction: null,
    }
    expect(meta.senderClass).toBe('transactional')
  })
})
