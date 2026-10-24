/**
 * @file The fifteen billing emails, one case each: the subject, the body's
 * key sentence in both parts, the one button's link, HTML escaping of every
 * user-chosen value, no user-chosen name in a subject, and a missing variable
 * naming itself. Pure rendering, so it lives under tests/unit/.
 */
import { describe, expect, it } from 'vite-plus/test'
import { renderIntervalSwitchScheduledTemplate } from '@/templates/email/interval-switch-scheduled.template'
import { renderMovedToFreeTemplate } from '@/templates/email/moved-to-free.template'
import { renderPaidCancelledTemplate } from '@/templates/email/paid-cancelled.template'
import { renderPaidWelcomeTemplate } from '@/templates/email/paid-welcome.template'
import { renderPayerLeftTemplate } from '@/templates/email/payer-left.template'
import { renderPaymentFailedTemplate } from '@/templates/email/payment-failed.template'
import { renderRenewalUpcomingTemplate } from '@/templates/email/renewal-upcoming.template'
import { renderTrialEndedTemplate } from '@/templates/email/trial-ended.template'
import { renderTrialEndingTemplate } from '@/templates/email/trial-ending.template'
import { renderTrialEndsTodayTemplate } from '@/templates/email/trial-ends-today.template'
import { renderTrialMidpointTemplate } from '@/templates/email/trial-midpoint.template'
import { renderTrialStartedTemplate } from '@/templates/email/trial-started.template'
import { renderUpgradeRequestFulfilledTemplate } from '@/templates/email/upgrade-request-fulfilled.template'
import { renderUpgradeRequestedTemplate } from '@/templates/email/upgrade-requested.template'
import { renderWinbackTemplate } from '@/templates/email/winback.template'
import type { RenderedEmail } from '@/utilities/email-template.utilities'

/**
 * The billing page link every case but one carries.
 */
const BILLING_LINK =
  'https://app.example.test/settings/workspace/acme/billing?utm_source=email&utm_medium=email&utm_campaign=x&utm_content=primary_button'

/**
 * A script-running value, put in every user-chosen variable.
 */
const PAYLOAD = '<img src=x onerror=alert(1)>'

/**
 * One template's case.
 */
interface TemplateCase {
  /**
   * The template key the render reports.
   */
  key: string
  /**
   * Render with the case's variables, the user-chosen ones replaced by `overrides`.
   */
  render: (overrides: Record<string, string>) => RenderedEmail
  /**
   * Every variable the template requires.
   */
  variables: Record<string, string>
  /**
   * The variables a person chose: the workspace's name, a teammate's name.
   */
  userChosen: readonly string[]
  /**
   * The exact subject.
   */
  subject: string
  /**
   * Sentences both parts carry.
   */
  sentences: readonly string[]
  /**
   * The button's link variable.
   */
  linkVariable: string
}

/**
 * Build a case whose render takes the merged variables.
 * @param testCase - The case, with a render over its own variables type.
 * @returns The case.
 */
function caseOf<V extends object>(
  testCase: Omit<TemplateCase, 'render' | 'variables'> & {
    variables: V
    renderWith: (variables: V) => RenderedEmail
  }
): TemplateCase {
  const { renderWith, variables, ...rest } = testCase
  return {
    ...rest,
    variables: variables as Record<string, string>,
    render: (overrides) => renderWith({ ...variables, ...overrides }),
  }
}

const CASES: readonly TemplateCase[] = [
  caseOf({
    key: 'trial_started',
    renderWith: renderTrialStartedTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      trialEndsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your Acme Paid trial runs until 7 November 2026',
    sentences: [
      'Everything in Paid is on until 7 November 2026. Then Rocket Co moves to Free. Nothing is deleted, and no card is needed.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'trial_midpoint',
    renderWith: renderTrialMidpointTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      daysLeft: '7',
      trialEndsOn: '7 November 2026',
      usageSummary: '5 members\n12 invitations sent',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: '7 days left in your Paid trial',
    sentences: ['5 members', '12 invitations sent'],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'trial_ending',
    renderWith: renderTrialEndingTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      trialEndsOn: '7 November 2026',
      memberLimit: '3',
      membersUsed: '5',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your Paid trial ends on 7 November 2026',
    sentences: [
      'After 7 November 2026, Rocket Co moves to Free.',
      'Free allows 3 members; you have 5.',
      'Upgrade to keep Paid: ₹999 a month or ₹9,990 a year.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'trial_ends_today',
    renderWith: renderTrialEndsTodayTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      memberLimit: '3',
      membersUsed: '5',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your Paid trial ends today',
    sentences: [
      'Today Rocket Co moves to Free.',
      'Free allows 3 members; you have 5.',
      'Upgrade to keep Paid: ₹999 a month or ₹9,990 a year.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'trial_ended',
    renderWith: renderTrialEndedTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      summary: 'Free allows 3 members, and Rocket Co has 5.',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName', 'summary'],
    subject: 'Your Acme workspace is now on Free',
    sentences: [
      'The Paid trial of Rocket Co ended, so it is on Free. Nothing is deleted.',
      'Free allows 3 members, and Rocket Co has 5.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'paid_welcome',
    renderWith: renderPaidWelcomeTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      amount: '999',
      interval: 'month',
      nextChargeOn: '7 November 2026',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: "You're on Paid",
    sentences: ['Rocket Co is on Paid for ₹999 a month.', 'The next charge is on 7 November 2026.'],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'renewal_upcoming',
    renderWith: renderRenewalUpcomingTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      renewsOn: '7 November 2026',
      amount: '9,990',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your yearly plan renews on 7 November 2026 for ₹9,990',
    sentences: ['To stop it, cancel before 7 November 2026 from Billing.'],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'payment_failed',
    renderWith: renderPaymentFailedTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      amount: '999',
      stoppedBy: 'halted',
      graceEndsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your payment of ₹999 failed',
    sentences: [
      'Your payment of ₹999 for Rocket Co failed.',
      'Update your card by 7 November 2026 to keep Paid. After that, Rocket Co moves to Free.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'moved_to_free',
    renderWith: renderMovedToFreeTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      downgradeCause: 'payment_failed',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your Acme workspace moved to Free',
    sentences: [
      'Rocket Co moved to Free.',
      'The payment for Paid failed, and the card was not updated before the grace period ended.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'paid_cancelled',
    renderWith: renderPaidCancelledTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      endsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Paid ends on 7 November 2026',
    sentences: [
      'Rocket Co keeps Paid until 7 November 2026, then moves to Free.',
      "You won't be charged again.",
      'To keep Paid, subscribe again from Billing.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'interval_switch_scheduled',
    renderWith: renderIntervalSwitchScheduledTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      interval: 'year',
      switchOn: '7 November 2026',
      amount: '9,990',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Your plan switches to yearly billing on 7 November 2026',
    sentences: ['From 7 November 2026, Rocket Co pays ₹9,990 a year.'],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'payer_left',
    renderWith: renderPayerLeftTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      payerName: 'Grace Hopper',
      leftOn: '1 November 2026',
      billingState: 'past_due',
      periodEndsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName', 'payerName'],
    subject: 'Your Acme workspace needs a new card',
    sentences: [
      'Grace Hopper paid for Paid and left Rocket Co on 1 November 2026.',
      'Add your card by 7 November 2026 to keep Paid.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'upgrade_requested',
    renderWith: renderUpgradeRequestedTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      requesterName: 'Grace Hopper',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName', 'requesterName'],
    subject: 'A teammate asked to upgrade your Acme workspace',
    sentences: [
      'Grace Hopper asked you to move Rocket Co to Paid.',
      'Paid costs ₹999 a month or ₹9,990 a year.',
    ],
    linkVariable: 'billingLink',
  }),
  caseOf({
    key: 'upgrade_request_fulfilled',
    renderWith: renderUpgradeRequestFulfilledTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      tenantLink: 'https://app.example.test/tenants/acme?utm_source=email',
    },
    userChosen: ['tenantName'],
    subject: 'Your Acme workspace is on Paid now',
    sentences: ['You asked to move Rocket Co to Paid. An owner upgraded it.'],
    linkVariable: 'tenantLink',
  }),
  caseOf({
    key: 'winback',
    renderWith: renderWinbackTemplate,
    variables: {
      appName: 'Acme',
      tenantName: 'Rocket Co',
      memberLimit: '3',
      monthlyPrice: '999',
      billingLink: BILLING_LINK,
    },
    userChosen: ['tenantName'],
    subject: 'Paid is still here for your Acme workspace',
    sentences: ['Rocket Co is on Free, which allows 3 members.'],
    linkVariable: 'billingLink',
  }),
]

describe('billing email templates', () => {
  it('has one case per billing template', () => {
    expect(CASES.map((testCase) => testCase.key)).toHaveLength(15)
  })

  describe.each(CASES)('$key', (testCase) => {
    it('reports its key and renders its subject', () => {
      const rendered = testCase.render({})
      expect(rendered.templateKey).toBe(testCase.key)
      expect(rendered.subject).toBe(testCase.subject)
    })

    it('carries its key sentences in both parts', () => {
      const rendered = testCase.render({})
      for (const sentence of testCase.sentences) {
        expect(rendered.text).toContain(sentence)
        expect(rendered.html).toContain(sentence.replaceAll("'", '&#39;'))
      }
    })

    it('has one button, to its link, in both parts', () => {
      const rendered = testCase.render({})
      const link = testCase.variables[testCase.linkVariable] ?? ''
      expect(rendered.text).toContain(link)
      const escaped = link.replaceAll('&', '&amp;')
      expect(rendered.html).toContain(`<a href="${escaped}">`)
      expect(rendered.html.match(/<a /g)).toHaveLength(1)
    })

    it('escapes every user-chosen value in html and keeps it out of the subject', () => {
      const overrides = Object.fromEntries(testCase.userChosen.map((name) => [name, PAYLOAD]))
      const rendered = testCase.render(overrides)
      expect(rendered.html).not.toContain(PAYLOAD)
      expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(rendered.text).toContain(PAYLOAD)
      expect(rendered.subject).not.toContain(PAYLOAD)
    })

    it('escapes a quote in the link, so it cannot leave the href attribute', () => {
      const rendered = testCase.render({
        [testCase.linkVariable]: 'https://app.example.test/x" onclick="alert(1)',
      })
      expect(rendered.html).not.toContain('" onclick="')
    })

    it('throws, naming each variable, when it is missing', () => {
      for (const name of Object.keys(testCase.variables)) {
        expect(() => testCase.render({ [name]: undefined as unknown as string })).toThrow(
          new RegExp(name)
        )
      }
    })
  })

  it('writes one member and one day in the singular', () => {
    const ending = renderTrialEndingTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      trialEndsOn: '7 November 2026',
      memberLimit: '1',
      membersUsed: '1',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: BILLING_LINK,
    })
    expect(ending.text).toContain('Free allows 1 member; you have 1.')
    const midpoint = renderTrialMidpointTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      daysLeft: '1',
      trialEndsOn: '7 November 2026',
      usageSummary: '1 member',
      billingLink: BILLING_LINK,
    })
    expect(midpoint.subject).toBe('1 day left in your Paid trial')
  })

  it.each([
    ['cancelled', 'Its Paid subscription was cancelled, and its paid period ended.'],
    ['staff', 'Our support team moved it to Free.'],
    [
      'lifecycle',
      'Its subscription was cancelled because the workspace was suspended or archived.',
    ],
  ] as const)('gives the %s cause its own sentence', (downgradeCause, sentence) => {
    const rendered = renderMovedToFreeTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      downgradeCause,
      billingLink: BILLING_LINK,
    })
    expect(rendered.text).toContain(sentence)
  })

  it('names the monthly interval in a switch to monthly billing', () => {
    const rendered = renderIntervalSwitchScheduledTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      interval: 'month',
      switchOn: '7 November 2026',
      amount: '999',
      billingLink: BILLING_LINK,
    })
    expect(rendered.subject).toBe('Your plan switches to monthly billing on 7 November 2026')
    expect(rendered.text).toContain('pays ₹999 a month.')
  })
})

describe('billing email variants', () => {
  it('tells a paused subscription apart from a failed payment, and asks for a payment method', () => {
    const rendered = renderPaymentFailedTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      amount: '999',
      stoppedBy: 'paused',
      graceEndsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    })
    expect(rendered.subject).toBe('Your Paid subscription is paused')
    expect(rendered.text).toContain(
      'Your subscription for Rocket Co was paused from your bank or UPI app.'
    )
    expect(rendered.text).not.toContain('failed')
    expect(rendered.text).toContain(
      'Update your payment method by 7 November 2026 to keep Paid. After that, Rocket Co moves to Free.'
    )
    expect(rendered.text).not.toContain('card')
    expect(rendered.html).toContain(
      `<a href="${BILLING_LINK.replaceAll('&', '&amp;')}">Update payment method</a>`
    )
  })

  it('asks for a card after a failed payment', () => {
    const rendered = renderPaymentFailedTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      amount: '999',
      stoppedBy: 'halted',
      graceEndsOn: '7 November 2026',
      billingLink: BILLING_LINK,
    })
    expect(rendered.html).toContain(
      `<a href="${BILLING_LINK.replaceAll('&', '&amp;')}">Update your card</a>`
    )
  })

  it('tells the owners a running subscription still charges the payer card, and when it renews', () => {
    const rendered = renderPayerLeftTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      payerName: 'Grace Hopper',
      leftOn: '1 November 2026',
      billingState: 'active',
      periodEndsOn: '30 November 2026',
      billingLink: BILLING_LINK,
    })
    expect(rendered.text).toContain(
      'The subscription still charges their card. It renews on 30 November 2026. To pay with your card, update the payment method in Billing.'
    )
    expect(rendered.text).not.toContain('moves to Free')
    expect(rendered.html).toContain(
      `<a href="${BILLING_LINK.replaceAll('&', '&amp;')}">Update payment method</a>`
    )
  })

  it('gives a suspended or archived workspace no button and no upgrade ask', () => {
    const rendered = renderMovedToFreeTemplate({
      appName: 'Acme',
      tenantName: 'Rocket Co',
      downgradeCause: 'lifecycle',
      billingLink: BILLING_LINK,
    })
    expect(rendered.html).not.toContain('<a ')
    expect(rendered.text).not.toContain(BILLING_LINK)
    expect(rendered.text).not.toContain('upgrade')
    expect(rendered.text).toContain('Rocket Co moved to Free.')
    expect(rendered.text).toContain('To restore it, contact support.')
  })
})
