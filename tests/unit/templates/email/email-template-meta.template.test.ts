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
  tenant_invitation: {
    tenantName: 'Acme',
    inviterName: 'Grace',
    role: 'viewer',
    acceptUrl: 'https://x.test/a',
    expiresInDays: '7',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'App',
  },
  onboarding_reminder: {
    tenantName: 'Acme',
    appName: 'App',
    nextStep: 'Invite a teammate',
    stepsDone: '1',
    stepsTotal: '3',
    overviewLink: 'https://x.test/tenants/acme',
  },
  maintenance_mode_changed: {
    firstName: 'Ada',
    appName: 'App',
    mode: 'full',
    actorName: 'Grace',
    reason: 'Database upgrade',
    changedAt: '2026-10-06T10:42:00.000Z',
  },
  sign_in_link: {
    firstName: 'Ada',
    signInUrl: 'https://x.test/auth/link?token=t&email=a%40x.test',
    expiresInMinutes: '15',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'App',
    reason: 'self',
  },
  passkey_created: {
    firstName: 'Ada',
    providerName: 'iCloud Keychain',
    occurredAt: '15:42 UTC on 20 October 2026',
    settingsUrl: 'https://x.test/settings/account/security',
    appName: 'App',
  },
  passkey_deleted: {
    firstName: 'Ada',
    providerName: 'iCloud Keychain',
    occurredAt: '15:42 UTC on 20 October 2026',
    settingsUrl: 'https://x.test/settings/account/security',
    appName: 'App',
  },
  step_up_link: {
    firstName: 'Ada',
    confirmUrl: 'https://x.test/auth/confirm?token=t',
    expiresInMinutes: '15',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'App',
  },
  welcome: {
    firstName: 'Ada',
    signInUrl: 'https://x.test/auth/link?token=t&email=a%40x.test',
    expiresInMinutes: '15',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'App',
  },
  invitation_confirm: {
    firstName: 'Ada',
    tenantName: 'Acme',
    role: 'editor',
    confirmUrl: 'https://x.test/invitations/confirm?token=t&email=a%40x.test',
    expiresInMinutes: '15',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'App',
  },
}

describe('EMAIL_TEMPLATE_META', () => {
  it('covers every template key', () => {
    expect(Object.keys(EMAIL_TEMPLATE_META).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...EMAIL_TEMPLATE_KEYS].toSorted((a, b) => a.localeCompare(b))
    )
  })

  it('pins each template to the spec', () => {
    expect(EMAIL_TEMPLATE_META).toEqual({
      tenant_invitation: {
        senderClass: 'transactional',
        previewVariables: ['tenantName', 'role', 'expiresInDays', 'expiresAt', 'appName'],
        resendAction: 'invitation',
      },
      onboarding_reminder: {
        senderClass: 'general',
        previewVariables: [
          'tenantName',
          'appName',
          'nextStep',
          'stepsDone',
          'stepsTotal',
          'overviewLink',
        ],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      maintenance_mode_changed: {
        senderClass: 'general',
        previewVariables: ['firstName', 'appName', 'mode', 'changedAt'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      sign_in_link: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName', 'reason'],
        resendAction: 'sign_in_link',
      },
      step_up_link: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      passkey_created: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'providerName', 'occurredAt', 'appName'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      passkey_deleted: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'providerName', 'occurredAt', 'appName'],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
      welcome: {
        senderClass: 'transactional',
        previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName'],
        resendAction: 'sign_in_link',
      },
      invitation_confirm: {
        senderClass: 'transactional',
        previewVariables: [
          'firstName',
          'tenantName',
          'role',
          'expiresInMinutes',
          'expiresAt',
          'appName',
        ],
        resendAction: 'invitation',
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

  it('offers no resend for the maintenance notice or a step-up link', () => {
    expect(EMAIL_TEMPLATE_META.maintenance_mode_changed.resendAction).toBeNull()
    expect(EMAIL_TEMPLATE_META.step_up_link.resendAction).toBeNull()
    expect(EMAIL_TEMPLATE_META.passkey_created.resendAction).toBeNull()
    expect(EMAIL_TEMPLATE_META.passkey_deleted.resendAction).toBeNull()
  })

  it('stores every onboarding reminder variable: its link carries no token', () => {
    expect(EMAIL_TEMPLATE_META.onboarding_reminder.previewVariables).toContain('overviewLink')
    expect(SECRET_VARIABLE_PATTERN.test('overviewLink')).toBe(false)
    expect(EMAIL_TEMPLATE_META.onboarding_reminder.resendAction).toBeNull()
  })
})

describe('assertTemplateMetaSafe', () => {
  it('passes the real registry, which it already checked when the module loaded', () => {
    expect(assertTemplateMetaSafe(EMAIL_TEMPLATE_META)).toBe(EMAIL_TEMPLATE_META)
  })

  it.each(['signInUrl', 'refreshToken'])('refuses a stored variable named %s', (name) => {
    const registry = {
      sign_in_link: {
        senderClass: 'transactional' as const,
        previewVariables: ['firstName', name],
        // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
        resendAction: null,
      },
    }
    expect(() => {
      assertTemplateMetaSafe(registry)
    }).toThrow(`"sign_in_link" lists "${name}"`)
  })
})

/**
 * Compile-time only: `tsc` (run by `pnpm lint`) reports an unused
 * `@ts-expect-error` if a rule stops holding. The runtime `expect`s only
 * keep each literal a real, read value.
 */
describe('EmailTemplateMeta type rules', () => {
  /**
   * Variables with a secret: `resetUrl` carries a token.
   */
  interface TokenVariables {
    firstName: string
    resetUrl: string
  }
  /**
   * Variables with no secret.
   */
  interface PlainVariables {
    firstName: string
  }

  it('refuses the general sender for variables that carry a secret', () => {
    const meta: EmailTemplateMeta<TokenVariables> = {
      // @ts-expect-error -- a template with a …Url variable must mail from the transactional sender
      senderClass: 'general',
      previewVariables: ['firstName'],
      resendAction: 'sign_in_link',
    }
    expect(meta.senderClass).toBe('general')
  })

  it('refuses to list a secret variable for storage', () => {
    const meta: EmailTemplateMeta<TokenVariables> = {
      senderClass: 'transactional',
      // @ts-expect-error -- resetUrl carries a token and may never be stored
      previewVariables: ['firstName', 'resetUrl'],
      resendAction: 'sign_in_link',
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
