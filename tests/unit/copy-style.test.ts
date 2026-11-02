/**
 * @file Every message express sends a person follows the copy rules: no
 * banned phrasing (vague failure words, weasel, peacock and filler words,
 * jargon) and no sentence over 30 words. The scan parses `src/` and collects
 * the text at each user-facing position: `HttpError` messages and their
 * field `errors` (a message held in a local variable is read where it is
 * set), the argument of a file's own message helper such as
 * `noSubscription(message)`, success messages, the `…_MESSAGE`,
 * `…_MESSAGES` and `…_SENTENCE` constants, what a `…Message` function
 * returns, every `message` property outside `src/configs`, validator messages, notification titles and bodies, onboarding
 * step copy and the CLI output of `src/scripts`. Each email template is
 * rendered instead of scanned, so its subject and text are checked as a
 * person reads them, and each staff billing alert is rendered from
 * `BILLING_ALERT_TEXT`, which Apex shows as sent. The frontends' `tests/unit/copy-style.test.ts` is the
 * model.
 *
 * A 5xx `HttpError` built with `exposeMessage: true` reaches the person, so
 * its message is scanned like a 4xx's.
 *
 * Out of scope, by design: log lines, internal `new Error` text outside
 * `src/scripts`, 5xx messages `errorHandler` masks, the email webhook's
 * answers (read by the provider) and the analytics proxy's (read by the
 * analytics SDK).
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vite-plus/test'
import { renderIntervalSwitchScheduledTemplate } from '@/templates/email/interval-switch-scheduled.template'
import { renderInvitationConfirmTemplate } from '@/templates/email/invitation-confirm.template'
import { renderMaintenanceModeChangedTemplate } from '@/templates/email/maintenance-mode-changed.template'
import { renderMovedToFreeTemplate } from '@/templates/email/moved-to-free.template'
import { renderOnboardingReminderTemplate } from '@/templates/email/onboarding-reminder.template'
import { renderPaidCancelledTemplate } from '@/templates/email/paid-cancelled.template'
import { renderPaidWelcomeTemplate } from '@/templates/email/paid-welcome.template'
import { renderPasskeyCreatedTemplate } from '@/templates/email/passkey-created.template'
import { renderPasskeyDeletedTemplate } from '@/templates/email/passkey-deleted.template'
import { renderPayerLeftTemplate } from '@/templates/email/payer-left.template'
import { renderPaymentFailedTemplate } from '@/templates/email/payment-failed.template'
import { renderRenewalUpcomingTemplate } from '@/templates/email/renewal-upcoming.template'
import { renderSignInLinkTemplate } from '@/templates/email/sign-in-link.template'
import { renderStepUpLinkTemplate } from '@/templates/email/step-up-link.template'
import { renderTaxDocumentIssuedTemplate } from '@/templates/email/tax-document-issued.template'
import { renderTenantInvitationTemplate } from '@/templates/email/tenant-invitation.template'
import { renderTrialEndedTemplate } from '@/templates/email/trial-ended.template'
import { renderTrialEndingTemplate } from '@/templates/email/trial-ending.template'
import { renderTrialEndsTodayTemplate } from '@/templates/email/trial-ends-today.template'
import { renderTrialMidpointTemplate } from '@/templates/email/trial-midpoint.template'
import { renderTrialStartedTemplate } from '@/templates/email/trial-started.template'
import { renderUpgradeRequestFulfilledTemplate } from '@/templates/email/upgrade-request-fulfilled.template'
import { renderUpgradeRequestedTemplate } from '@/templates/email/upgrade-requested.template'
import { renderWelcomeTemplate } from '@/templates/email/welcome.template'
import { renderWinbackTemplate } from '@/templates/email/winback.template'
import {
  BILLING_ALERT_TEXT,
  type BillingAlertTextKey,
} from '@/utilities/billing-alert-text.utilities'
import type { EmailTemplateKey, RenderedEmail } from '@/utilities/email-template.utilities'

const SOURCE_ROOT = path.resolve(process.cwd(), 'src')

/**
 * Files whose answers are read by a machine, not a person.
 */
const MACHINE_FACING = new Set([
  'src/routes/analytics-proxy.routes.ts',
  'src/services/email-webhook.service.ts',
  'src/controllers/email-webhook.controller.ts',
  'src/services/billing/billing-webhook.service.ts',
  'src/controllers/billing-webhook.controller.ts',
  // GSTR-1 column headers and cell values, named as the GST offline tool reads them.
  'src/constants/gst-export.constants.ts',
])

/**
 * Phrasings the copy rules ban, matched case-insensitively on whole words.
 * `most` is allowed in "at most 100", which is a limit, not a hedge.
 */
const BANNED: readonly RegExp[] = [
  // Vague failure words.
  /\bcould not\b/i,
  /\bunable to\b/i,
  /\binvalid\b/i,
  /\bsomething went wrong\b/i,
  /\ban error occurred\b/i,
  /\bfailed to\b/i,
  /\boops\b/i,
  // Weasel words. `may` is a hedge; the month in a date ("7 May 2027", "May 2027") is not.
  /(?<!\d )\bmay\b(?! \d)/i,
  /\ba few\b/i,
  /\ba while\b/i,
  /\bnearly\b/i,
  /\bsignificant(?:ly)?\b/i,
  /\bgenerally\b/i,
  /\busually\b/i,
  /\boften\b/i,
  /\bsome\b/i,
  /\bseveral\b/i,
  /\bmany\b/i,
  /(?<!\bat )\bmost\b/i,
  /\bvery\b/i,
  /\bmight\b/i,
  /\bvarious\b/i,
  /\ba lot\b/i,
  /\bquickly\b/i,
  /\beasily\b/i,
  /\bshortly\b/i,
  /\bsoon\b/i,
  /\blater\b/i,
  /\bexperts say\b/i,
  /\bresearch shows\b/i,
  // Filler, hype and peacock words.
  /\bplease\b/i,
  /\bsuccessfully\b/i,
  /\bwas able to\b/i,
  /\bin order to\b/i,
  /\bcurrently\b/i,
  /\bsimply\b/i,
  /\bjust\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bexciting\b/i,
  /\boutstanding\b/i,
  /\binnovative\b/i,
  /\bworld-class\b/i,
  /\bpowerful\b/i,
  /\bbest-in-class\b/i,
  // Jargon a person should never read.
  /\btokens?\b/i,
  /\bmagic link\b/i,
  /\bstep-up\b/i,
  /\bUUID\b/,
  /\bNUL\b/,
]

/**
 * The contracted failure word. Allowed only with a next step after it, the
 * frontends' "We couldn't load X. Select Try again." pattern, since every
 * error must say what to do next; alone it says only that something failed.
 */
const CONTRACTED_FAILURE = /\bcouldn['’]t\b/i

/**
 * The longest sentence the rules allow, in words.
 */
const MAX_SENTENCE_WORDS = 30

/**
 * One piece of copy and where it came from.
 */
interface Copy {
  where: string
  text: string
}

/**
 * Every `.ts` file under a directory.
 * @param directory - Where to start.
 * @returns The absolute paths.
 */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/**
 * The text of a string or template literal, each `${…}` read as one word.
 * @param node - The expression.
 * @returns The text, or undefined when the node is not a literal.
 */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `X${span.literal.text}`).join('')
  }
  return undefined
}

/**
 * The expression a parenthesis or an `as` wraps, unwrapped.
 * @param node - The expression.
 * @returns The innermost expression.
 */
function unwrapped(node: ts.Node): ts.Node {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression
  }
  return current
}

/**
 * Every literal inside an expression: both arms of a conditional, either
 * side of `??` or `||`, and each element of an array or value of an object.
 * @param node - The expression.
 * @returns The literals' text.
 */
function literalsIn(node: ts.Node): string[] {
  const inner = unwrapped(node)
  const text = literalText(inner)
  if (text !== undefined) return [text]
  let parts: readonly ts.Node[] = []
  if (ts.isConditionalExpression(inner)) parts = [inner.whenTrue, inner.whenFalse]
  if (ts.isBinaryExpression(inner)) parts = [inner.left, inner.right]
  if (ts.isArrayLiteralExpression(inner)) parts = inner.elements
  if (ts.isObjectLiteralExpression(inner)) {
    parts = inner.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) ? [property.initializer] : []
    )
  }
  return parts.flatMap((part) => literalsIn(part))
}

/**
 * The HTTP status a call passes, when it is a number literal.
 * @param argument - The status argument, if any.
 * @returns The status, or undefined.
 */
function statusOf(argument: ts.Expression | undefined): number | undefined {
  return argument !== undefined && ts.isNumericLiteral(argument) ? Number(argument.text) : undefined
}

/**
 * Whether a node sits inside a class that extends `HttpError`.
 * @param node - Any node.
 * @returns True inside such a class.
 */
function isInHttpErrorClass(node: ts.Node): boolean {
  let current: ts.Node = node
  while (!ts.isSourceFile(current) && !ts.isClassDeclaration(current)) current = current.parent
  return (
    ts.isClassDeclaration(current) &&
    (current.heritageClauses?.some((clause) =>
      clause.types.some((type) => type.expression.getText() === 'HttpError')
    ) ??
      false)
  )
}

/**
 * Which positions a file's copy sits at, by where the file lives, and the
 * file's own message helpers.
 */
interface FileKind {
  isValidator: boolean
  isScript: boolean
  isOnboardingSteps: boolean
  isService: boolean
  isConfig: boolean
  /**
   * Each function in the file that turns a `message` parameter into a 4xx
   * `HttpError`, by name, with that parameter's position.
   */
  messageHelpers: ReadonlyMap<string, number>
}

/**
 * Whether an `HttpError` construction's status is a 4xx a person reads, not
 * a 5xx `errorHandler` masks.
 * @param callArguments - The construction's arguments.
 * @returns True for a literal status under 500.
 */
function isClientStatus(callArguments: readonly ts.Expression[]): boolean {
  return (statusOf(callArguments[1]) ?? 500) < 500
}

/**
 * The function, method or arrow function a node sits in.
 * @param node - Any node.
 * @returns The innermost function-like node, or the source file.
 */
function enclosingFunction(node: ts.Node): ts.Node {
  let current = node.parent
  while (!ts.isSourceFile(current) && !ts.isFunctionLike(current)) current = current.parent
  return current
}

/**
 * Each value a local variable holds where it is declared and assigned in its
 * function: what `let message = '…'` and each later `message = '…'` set.
 * @param identifier - The variable as an `HttpError` message argument.
 * @returns The initializer and each assigned value.
 */
function assignedValues(identifier: ts.Identifier): ts.Expression[] {
  const name = identifier.text
  const values: ts.Expression[] = []
  /**
   * Collect the declarations and assignments of `name` under `node`.
   * @param node - The node to check.
   */
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      values.push(node.initializer)
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      values.push(node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(enclosingFunction(identifier))
  return values
}

/**
 * Whether an `HttpError`'s options argument is an object literal that sets
 * `exposeMessage: true`.
 * @param options - The options argument, if any.
 * @returns True when the message opts out of the 5xx mask.
 */
function hasExposedMessage(options: ts.Expression | undefined): boolean {
  if (options === undefined) return false
  const inner = unwrapped(options)
  return (
    ts.isObjectLiteralExpression(inner) &&
    inner.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === 'exposeMessage' &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword
    )
  )
}

/**
 * The message and field `errors` an `HttpError` construction shows a
 * person: none for a 5xx, which `errorHandler` masks, unless it sets
 * `exposeMessage: true`. A message held in a local variable is read where
 * the variable is set.
 * @param callArguments - The construction's arguments.
 * @returns The nodes holding copy.
 */
function httpErrorCopy(callArguments: readonly ts.Expression[]): ts.Expression[] {
  const message = callArguments[0]
  const errors = callArguments[3]
  const options = callArguments[4]
  if (message === undefined) return []
  if (!isClientStatus(callArguments) && !hasExposedMessage(options)) return []
  const messages = ts.isIdentifier(message) ? assignedValues(message) : [message]
  return errors === undefined ? messages : [...messages, errors]
}

/**
 * The position of a function's parameter named `message`.
 * @param node - A function-like node.
 * @returns The position, or -1.
 */
function messageParameterIndex(node: ts.SignatureDeclaration): number {
  return node.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'message'
  )
}

/**
 * Whether a function body hands its `message` parameter to a 4xx
 * `HttpError`, directly or through a helper already known.
 * @param body - The function's body.
 * @param helpers - The helpers found so far.
 * @returns True when it does.
 */
function didForwardMessage(body: ts.Node, helpers: ReadonlyMap<string, number>): boolean {
  let didForward = false
  /**
   * Look for the hand-off under `node`.
   * @param node - The node to check.
   */
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText() === 'HttpError') {
      const [first] = node.arguments ?? []
      if (first?.getText() === 'message' && isClientStatus(node.arguments ?? [])) didForward = true
    }
    if (ts.isCallExpression(node)) {
      const index = helpers.get(node.expression.getText())
      if (index !== undefined && node.arguments[index]?.getText() === 'message') didForward = true
    }
    if (!didForward) ts.forEachChild(node, visit)
  }
  visit(body)
  return didForward
}

/**
 * The file's message helpers, such as `noSubscription(message)`: each named
 * function with a `message` parameter it turns into a 4xx `HttpError`,
 * itself or through another helper, so a call's argument there is copy.
 * @param source - The parsed file.
 * @returns Each helper's name and its `message` parameter's position.
 */
function messageHelpersIn(source: ts.SourceFile): Map<string, number> {
  const candidates: { name: string; index: number; body: ts.Node }[] = []
  /**
   * Collect each named function with a `message` parameter under `node`.
   * @param node - The node to check.
   */
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      const index = messageParameterIndex(node)
      if (index !== -1) candidates.push({ name: node.name.text, index, body: node.body })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const helpers = new Map<string, number>()
  for (let didGrow = true; didGrow;) {
    didGrow = false
    for (const { name, index, body } of candidates) {
      if (!helpers.has(name) && didForwardMessage(body, helpers)) {
        helpers.set(name, index)
        didGrow = true
      }
    }
  }
  return helpers
}

/**
 * The nodes holding copy in one call or construction.
 * @param node - A call or `new` expression.
 * @param kind - Where its file lives.
 * @returns The nodes holding copy.
 */
function callCopy(node: ts.CallExpression | ts.NewExpression, kind: FileKind): ts.Expression[] {
  const callee = node.expression.getText()
  const callArguments = node.arguments ?? []
  if (ts.isNewExpression(node)) {
    if (callee === 'HttpError') return httpErrorCopy(callArguments)
    const isScriptFailure = kind.isScript && /(?:Error|Failure)$/.test(callee)
    return isScriptFailure && callArguments[0] !== undefined ? [callArguments[0]] : []
  }
  if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return isInHttpErrorClass(node) ? httpErrorCopy(callArguments) : []
  }
  const helperIndex = kind.messageHelpers.get(callee)
  if (helperIndex !== undefined) return callArguments.slice(helperIndex, helperIndex + 1)
  const position = { successResponse: 2, messageResponse: 1, errorResponse: 1 }[callee]
  if (position !== undefined) return callArguments.slice(position, position + 1)
  if (kind.isScript && /^(?:process\.std(?:out|err)\.write|console\.\w+)$/.test(callee)) {
    return callArguments.slice(0, 1)
  }
  if (kind.isValidator && ts.isPropertyAccessExpression(node.expression)) {
    return callArguments.slice(1).filter((argument) => literalText(argument) !== undefined)
  }
  return []
}

/**
 * What a function returns, from its own `return` statements; a function
 * nested inside it returns for itself.
 * @param body - The function's body.
 * @returns Each returned expression.
 */
function returnedValues(body: ts.Node): ts.Expression[] {
  const values: ts.Expression[] = []
  /**
   * Collect the returns under `node`.
   * @param node - The node to check.
   */
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) values.push(node.expression)
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return values
}

/**
 * The nodes holding copy in one declaration or property: a `…_MESSAGE`,
 * `…_MESSAGES` or `…_SENTENCE` constant, what a `…Message` function returns,
 * a `message` property (and a validator's `error`), a notification's `title`
 * or `body`, or an onboarding step's copy.
 * @param node - Any node.
 * @param kind - Where its file lives.
 * @returns The nodes, or none.
 */
function namedCopy(node: ts.Node, kind: FileKind): ts.Expression[] {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const isCopy = /_(?:MESSAGES?|SENTENCE)$/.test(node.name.text)
    return isCopy && node.initializer !== undefined ? [node.initializer] : []
  }
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return (node.name?.text ?? '').endsWith('Message') ? returnedValues(node.body) : []
  }
  if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return []
  const key = node.name.text
  const isCopy =
    (!kind.isConfig && key === 'message') ||
    (kind.isValidator && key === 'error') ||
    (kind.isService && (key === 'title' || key === 'body')) ||
    (kind.isOnboardingSteps && (key === 'title' || key === 'description'))
  return isCopy ? [node.initializer] : []
}

/**
 * The copy one source file holds at user-facing positions.
 * @param relative - The file's path from the repo root, which decides the positions read.
 * @param text - The file's text.
 * @returns Each piece of copy.
 */
function copyInSource(relative: string, text: string): Copy[] {
  if (MACHINE_FACING.has(relative)) return []
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true)
  const kind: FileKind = {
    isValidator: relative.startsWith('src/validators/'),
    isScript: relative.startsWith('src/scripts/'),
    isOnboardingSteps: relative === 'src/constants/onboarding.constants.ts',
    isService: relative.startsWith('src/services/'),
    isConfig: relative.startsWith('src/configs/'),
    messageHelpers: messageHelpersIn(source),
  }
  const found: Copy[] = []
  /**
   * Collect the copy at `node`, then at its children.
   * @param node - The node to check.
   */
  const visit = (node: ts.Node): void => {
    const holders = [
      ...(ts.isCallExpression(node) || ts.isNewExpression(node) ? callCopy(node, kind) : []),
      ...namedCopy(node, kind),
    ]
    for (const holder of holders) {
      const { line } = source.getLineAndCharacterOfPosition(holder.getStart())
      for (const copy of literalsIn(holder)) {
        found.push({ where: `${relative}:${String(line + 1)}`, text: copy })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Every message express sends a person, from `src/`.
 * @returns Each piece of copy.
 */
function sourceCopy(): Copy[] {
  return sourceFiles(SOURCE_ROOT).flatMap((file) =>
    copyInSource(path.relative(process.cwd(), file), fs.readFileSync(file, 'utf8'))
  )
}

/**
 * The fixed instant a fixture's expiry reads as.
 */
const EXPIRES_AT = '15:42 UTC on 20 October 2026'

/**
 * Each template, rendered with realistic variables. A `Record` over
 * `EmailTemplateKey`, so a new template fails to compile until it is here.
 */
const RENDERED: Record<EmailTemplateKey, readonly RenderedEmail[]> = {
  sign_in_link: (['self', 'staff'] as const).map((reason) =>
    renderSignInLinkTemplate({
      firstName: 'Ada',
      signInUrl: 'https://app.example.test/auth/link?code=abc',
      expiresInMinutes: '15',
      expiresAt: EXPIRES_AT,
      appName: 'Acme',
      reason,
    })
  ),
  welcome: [
    renderWelcomeTemplate({
      firstName: 'Ada',
      signInUrl: 'https://app.example.test/auth/link?code=abc',
      expiresInMinutes: '15',
      expiresAt: EXPIRES_AT,
      appName: 'Acme',
    }),
  ],
  step_up_link: [
    renderStepUpLinkTemplate({
      firstName: 'Ada',
      confirmUrl: 'https://apex.example.test/auth/confirm?code=abc',
      expiresInMinutes: '10',
      expiresAt: EXPIRES_AT,
      appName: 'Apex',
    }),
  ],
  passkey_created: [
    renderPasskeyCreatedTemplate({
      firstName: 'Ada',
      providerName: 'iCloud Keychain',
      occurredAt: EXPIRES_AT,
      settingsUrl: 'https://app.example.test/settings/account/security',
      appName: 'Acme',
    }),
  ],
  passkey_deleted: [
    renderPasskeyDeletedTemplate({
      firstName: 'Ada',
      providerName: 'iCloud Keychain',
      occurredAt: EXPIRES_AT,
      settingsUrl: 'https://app.example.test/settings/account/security',
      appName: 'Acme',
    }),
  ],
  invitation_confirm: [
    renderInvitationConfirmTemplate({
      firstName: 'Ada',
      tenantName: 'Acme Robotics',
      role: 'admin',
      confirmUrl: 'https://app.example.test/invitations/confirm?code=abc',
      expiresInMinutes: '15',
      expiresAt: EXPIRES_AT,
      appName: 'Acme',
    }),
  ],
  tenant_invitation: ['1', '7'].map((expiresInDays) =>
    renderTenantInvitationTemplate({
      tenantName: 'Acme Robotics',
      inviterName: 'Grace Hopper',
      role: 'member',
      acceptUrl: 'https://app.example.test/invitations/accept?code=abc',
      expiresInDays,
      expiresAt: EXPIRES_AT,
      appName: 'Acme',
    })
  ),
  onboarding_reminder: [
    renderOnboardingReminderTemplate({
      tenantName: 'Acme Robotics',
      appName: 'Acme',
      nextStep: 'Invite a teammate',
      stepsDone: '1',
      stepsTotal: '3',
      overviewLink: 'https://app.example.test/acme',
    }),
  ],
  maintenance_mode_changed: [
    renderMaintenanceModeChangedTemplate({
      firstName: 'Ada',
      appName: 'Acme',
      mode: 'read-only',
      actorName: 'Grace Hopper',
      reason: 'Database upgrade',
      changedAt: EXPIRES_AT,
    }),
  ],
  trial_started: [
    renderTrialStartedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      trialEndsOn: '7 November 2026',
      paidIncludes: 'Workspace insights and no member limit',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  trial_midpoint: [
    renderTrialMidpointTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      trialEndsOn: '7 November 2026',
      usageSummary: '5 members\n12 invitations sent\nWorkspace insights opened 4 times',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  trial_ending: ['1', '7'].map((memberLimit) =>
    renderTrialEndingTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      trialEndsOn: '7 November 2026',
      memberLimit,
      membersUsed: '5',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    })
  ),
  trial_ends_today: [
    renderTrialEndsTodayTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      trialEndsOn: '7 November 2026',
      memberLimit: '3',
      membersUsed: '5',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  trial_ended: [
    renderTrialEndedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      summary:
        'Free allows 3 members, and Acme Robotics has 5. No one new can join while it has 3 or more.\nThese Paid features are off: Workspace insights.',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  paid_welcome: [
    renderPaidWelcomeTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      amount: '999',
      interval: 'month',
      nextChargeOn: '7 November 2026',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  renewal_upcoming: [
    renderRenewalUpcomingTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      renewsOn: '7 November 2026',
      amount: '999',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  payment_failed: (['halted', 'paused'] as const).map((stoppedBy) =>
    renderPaymentFailedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      amount: '999',
      stoppedBy,
      graceEndsOn: '7 November 2026',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    })
  ),
  moved_to_free: (
    ['payment_failed', 'cancelled', 'staff', 'suspended', 'archived', 'lifecycle'] as const
  ).map((downgradeCause) =>
    renderMovedToFreeTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      downgradeCause,
      graceEndedOn: downgradeCause === 'payment_failed' ? '7 November 2026' : '',
      supportEmail: 'support@example.com',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    })
  ),
  paid_cancelled: (['false', 'true'] as const).map((beforeFirstCharge) =>
    renderPaidCancelledTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      endsOn: '7 November 2026',
      beforeFirstCharge,
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    })
  ),
  interval_switch_scheduled: (['month', 'year'] as const).map((interval) =>
    renderIntervalSwitchScheduledTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      interval,
      switchOn: '7 November 2026',
      amount: '999',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    })
  ),
  payer_left: [
    ...(['active', 'past_due'] as const).map((billingState) =>
      renderPayerLeftTemplate({
        appName: 'Acme',
        tenantName: 'Acme Robotics',
        payerName: 'Grace Hopper',
        leftOn: '1 November 2026',
        billingState,
        periodEndsOn: '7 November 2026',
        billingLink: 'https://app.example.test/settings/workspace/acme/billing',
      })
    ),
    // An active subscription with no real renewal date to state.
    renderPayerLeftTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      payerName: 'Grace Hopper',
      leftOn: '1 November 2026',
      billingState: 'active',
      periodEndsOn: '',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  upgrade_requested: [
    renderUpgradeRequestedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      requesterName: 'Grace Hopper',
      monthlyPrice: '999',
      yearlyPrice: '9,990',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  upgrade_request_fulfilled: [
    renderUpgradeRequestFulfilledTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      paidIncludes: 'Workspace insights and no member limit',
      tenantLink: 'https://app.example.test/tenants/acme',
    }),
  ],
  winback: [
    renderWinbackTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      memberLimit: '3',
      monthlyPrice: '999',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
  tax_document_issued: [
    renderTaxDocumentIssuedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      documentType: 'invoice',
      documentNumber: 'INV/26-27/00001',
      invoiceNumber: '',
      creditAmount: '',
      issuedOn: '27 October 2026',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
    renderTaxDocumentIssuedTemplate({
      appName: 'Acme',
      tenantName: 'Acme Robotics',
      documentType: 'credit_note',
      documentNumber: 'CN/26-27/00001',
      invoiceNumber: 'INV/26-27/00001',
      creditAmount: '1,178.82',
      issuedOn: '27 October 2026',
      billingLink: 'https://app.example.test/settings/workspace/acme/billing',
    }),
  ],
}

/**
 * The copy each rendered template's subject and text part hold. The HTML
 * part repeats the text part, so it is not checked twice.
 * @returns Each piece of copy.
 */
function templateCopy(): Copy[] {
  return Object.entries(RENDERED).flatMap(([key, renders]) =>
    renders.flatMap((rendered) => [
      { where: `${key} subject`, text: rendered.subject },
      ...rendered.text
        .split('\n')
        .filter((line) => !line.startsWith('http'))
        .map((line) => ({ where: `${key} text`, text: line })),
    ])
  )
}

/**
 * Each staff billing alert, rendered with realistic ids. A `Record` over
 * the alert texts' keys, so a new alert fails to compile until it is here.
 */
const ALERTS: Record<BillingAlertTextKey, string> = {
  foreignSubscription: BILLING_ALERT_TEXT.foreignSubscription('sub_Q1'),
  unknownPrice: BILLING_ALERT_TEXT.unknownPrice('sub_Q1'),
  cancelFailed: BILLING_ALERT_TEXT.cancelFailed('sub_Q1'),
  switchCancelFailed: BILLING_ALERT_TEXT.switchCancelFailed('sub_Q1'),
  switchCancelNotRecorded: BILLING_ALERT_TEXT.switchCancelNotRecorded(
    'sub_Q1',
    new Date('2026-11-07T10:30:00.000Z')
  ),
  duplicateCancelFailed: BILLING_ALERT_TEXT.duplicateCancelFailed('sub_Q1'),
  duplicateRefundFailed: BILLING_ALERT_TEXT.duplicateRefundFailed('sub_Q1'),
  duplicateRefunded: BILLING_ALERT_TEXT.duplicateRefunded('sub_Q1', 14_999_950, 'rfnd_R1'),
  duplicateNothingPaid: BILLING_ALERT_TEXT.duplicateNothingPaid('sub_Q1'),
  duplicatePartlyRefunded: BILLING_ALERT_TEXT.duplicatePartlyRefunded('sub_Q1', 99_900, 49_900),
  archivedCancelFailed: BILLING_ALERT_TEXT.archivedCancelFailed('sub_Q1'),
  archivedRefundFailed: BILLING_ALERT_TEXT.archivedRefundFailed('sub_Q1'),
  archivedRefunded: BILLING_ALERT_TEXT.archivedRefunded('sub_Q1', 99_900, 'rfnd_R1'),
  archivedNothingPaid: BILLING_ALERT_TEXT.archivedNothingPaid('sub_Q1'),
  archivedPartlyRefunded: BILLING_ALERT_TEXT.archivedPartlyRefunded('sub_Q1', 99_900, 49_900),
  subscriptionCompleted: BILLING_ALERT_TEXT.subscriptionCompleted('sub_Q1'),
  lateSwitchRefunded: BILLING_ALERT_TEXT.lateSwitchRefunded('sub_Q2', 'sub_Q1'),
  activeWithoutPeriodEnd: BILLING_ALERT_TEXT.activeWithoutPeriodEnd('sub_Q1'),
  trialEndConflict: BILLING_ALERT_TEXT.trialEndConflict(),
  trialEndSyncFailed: BILLING_ALERT_TEXT.trialEndSyncFailed(),
  trialEndUnknownSubscription: BILLING_ALERT_TEXT.trialEndUnknownSubscription(),
  lifecycleCancelFailed: BILLING_ALERT_TEXT.lifecycleCancelFailed('sub_Q1'),
  lifecycleReadFailed: BILLING_ALERT_TEXT.lifecycleReadFailed('sub_Q1'),
  lifecycleCheckoutReadFailed: BILLING_ALERT_TEXT.lifecycleCheckoutReadFailed('sub_Q1'),
  lifecycleCheckoutSyncFailed: BILLING_ALERT_TEXT.lifecycleCheckoutSyncFailed(),
  reconcileListFailed: BILLING_ALERT_TEXT.reconcileListFailed('2026-10-27', 3),
  disputeStatusUnread: BILLING_ALERT_TEXT.disputeStatusUnread('pay_P1'),
  paidSubscriptionUnheld: BILLING_ALERT_TEXT.paidSubscriptionUnheld('sub_Q1'),
  disputeUnheld: BILLING_ALERT_TEXT.disputeUnheld('pay_P1'),
  disputeOpen: BILLING_ALERT_TEXT.disputeOpen('pay_P1'),
  webhookFailed: BILLING_ALERT_TEXT.webhookFailed('evt_E1', 'subscription.charged', 31),
  stillRetrying: BILLING_ALERT_TEXT.stillRetrying('Razorpay event evt_E1 (subscription.charged)'),
  taxHeldSez: BILLING_ALERT_TEXT.taxHeldSez('pay_P1', 99_900),
  taxHeldSezRefunded: BILLING_ALERT_TEXT.taxHeldSezRefunded('pay_P1', 99_900, 'rfnd_R1'),
  taxIssueFailed: BILLING_ALERT_TEXT.taxIssueFailed('tenant-1', '2026-10-27'),
  taxRefundOverCredit: BILLING_ALERT_TEXT.taxRefundOverCredit(
    'rfnd_R1',
    50_000,
    20_000,
    'INV/26-27/00001'
  ),
  taxInvoiceLate: BILLING_ALERT_TEXT.taxInvoiceLate(3, 'INV/26-27/00001', 'INV/26-27/00003'),
  taxCreditNoteLate: BILLING_ALERT_TEXT.taxCreditNoteLate(
    'CN/27-28/00001',
    'INV/26-27/00001',
    2027
  ),
}

/**
 * Alert wordings a key renders only for some arguments, checked beside `ALERTS`.
 */
const ALERT_VARIANTS: ReadonlyArray<[string, string]> = [
  [
    'switchCancelNotRecorded (no cycle end)',
    BILLING_ALERT_TEXT.switchCancelNotRecorded('sub_Q1', null),
  ],
  [
    'duplicatePartlyRefunded (no refunded amount)',
    BILLING_ALERT_TEXT.duplicatePartlyRefunded('sub_Q1', 99_900, null),
  ],
  [
    'duplicatePartlyRefunded (no amount paid)',
    BILLING_ALERT_TEXT.duplicatePartlyRefunded('sub_Q1', null, 49_900),
  ],
  [
    'archivedPartlyRefunded (no amounts)',
    BILLING_ALERT_TEXT.archivedPartlyRefunded('sub_Q1', null, null),
  ],
  [
    'taxInvoiceLate (one)',
    BILLING_ALERT_TEXT.taxInvoiceLate(1, 'INV/26-27/00001', 'INV/26-27/00001'),
  ],
]

/**
 * What breaks the rules in one piece of copy.
 * @param text - The copy.
 * @returns Each problem, or none.
 */
function problemsIn(text: string): string[] {
  const banned = BANNED.filter((pattern) => pattern.test(text)).map(
    (pattern) => `banned ${pattern.source}`
  )
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== '')
  const lastContracted = sentences.findLastIndex((sentence) => CONTRACTED_FAILURE.test(sentence))
  const contracted =
    lastContracted !== -1 && lastContracted === sentences.length - 1
      ? [`banned ${CONTRACTED_FAILURE.source} with no next step`]
      : []
  const long = sentences
    .filter((sentence) => sentence.trim().split(/\s+/).length > MAX_SENTENCE_WORDS)
    .map((sentence) => `over ${MAX_SENTENCE_WORDS} words: ${sentence}`)
  return [...banned, ...contracted, ...long]
}

/**
 * Each piece of copy that breaks a rule, as `where: problem — text`.
 * @param copy - The copy to check.
 * @returns The offenders.
 */
function offenders(copy: readonly Copy[]): string[] {
  return copy.flatMap(({ where, text }) =>
    problemsIn(text).map((problem) => `${where}: ${problem} — ${text}`)
  )
}

describe('user-facing copy', () => {
  it('flags banned phrasings and long sentences, and allows a limit', () => {
    expect(problemsIn('Could not load the list.')).toHaveLength(1)
    expect(problemsIn('Your access token expired.')).toHaveLength(1)
    expect(problemsIn('Too many attempts.')).toHaveLength(1)
    expect(problemsIn('Name must be at most 100 characters.')).toEqual([])
    expect(problemsIn(`${'word '.repeat(30)}end.`)).toHaveLength(1)
    expect(problemsIn(`${'word '.repeat(29)}end.`)).toEqual([])
  })

  it('flags a contracted failure word with no next step, and allows one with a next step', () => {
    expect(problemsIn("We couldn't load the list.")).toHaveLength(1)
    expect(problemsIn('We couldn’t load the list.')).toHaveLength(1)
    expect(problemsIn("Refresh the page. We couldn't load the list.")).toHaveLength(1)
    expect(problemsIn("We couldn't load the list. Refresh the page.")).toEqual([])
  })

  it('flags the hedges "may", "a few" and "a while", and allows the month May', () => {
    expect(problemsIn('It may have been deleted. Refresh the list.')).toHaveLength(1)
    expect(problemsIn('Try again in a few minutes.')).toHaveLength(1)
    expect(problemsIn('This can take a while. Refresh the page.')).toHaveLength(1)
    expect(problemsIn('Your trial ends on 7 May 2027.')).toEqual([])
    expect(problemsIn('Statements for May 2027 are ready.')).toEqual([])
  })

  it('collects copy passed through a message helper, a message variable and a message function', () => {
    const probe = [
      'function refuse(message: string): HttpError { return new HttpError(message, 409) }',
      'function masked(message: string): HttpError { return new HttpError(message, 502) }',
      "throw refuse('Probe helper argument.')",
      "throw masked('Probe masked helper.')",
      'function pick(flag: boolean): HttpError {',
      "  let message = 'Probe first branch.'",
      "  if (flag) message = 'Probe second branch.'",
      '  return new HttpError(message, 409)',
      '}',
      'function probeMessage(count: number): string { return `Probe ${String(count)} returned.` }',
      "const answer = { code: 'probe', message: 'Probe property.' }",
      "const PROBE_MESSAGES = { one: 'Probe map entry.' }",
      "logger.warn('Probe log line.', { reason: 'Probe log field.' })",
    ].join('\n')
    expect(
      copyInSource('src/services/probe.ts', probe)
        .map((copy) => copy.text)
        .toSorted()
    ).toEqual(
      [
        'Probe helper argument.',
        'Probe first branch.',
        'Probe second branch.',
        'Probe X returned.',
        'Probe property.',
        'Probe map entry.',
      ].toSorted()
    )
  })

  it('collects copy from every user-facing position, and not from logs or comments', () => {
    const probe = [
      "throw new HttpError('Probe client message.', 409, 'probe', { field: ['Probe field.'] })",
      "throw new HttpError('Probe masked message.', 500)",
      "throw new HttpError('Probe guidance.', 503, 'probe', undefined, { exposeMessage: true })",
      "throw new HttpError(retryable ? 'Probe wait.' : 'Probe refusal.', retryable ? 503 : 502, 'probe', undefined, { cause, exposeMessage: true })",
      "successResponse(response, data, 'Probe success.')",
      "const PROBE_MESSAGE = 'Probe constant.'",
      "logger.warn('Probe log line.')",
      '// Probe comment.',
    ].join('\n')
    expect(copyInSource('src/controllers/probe.ts', probe).map((copy) => copy.text)).toEqual([
      'Probe client message.',
      'Probe field.',
      'Probe guidance.',
      'Probe wait.',
      'Probe refusal.',
      'Probe success.',
      'Probe constant.',
    ])
  })

  it('finds the copy it guards', () => {
    const texts = sourceCopy().map((copy) => copy.text)
    expect(texts.length).toBeGreaterThan(200)
    expect(texts).toContain('Sign in to continue.')
    expect(texts).toContain('Invitation accepted.')
    expect(texts).toContain('Your billing is updating right now. Try again in 30 seconds.')
    expect(texts).toContain('Our payment provider did not answer. Try again in 30 seconds.')
    expect(texts).toContain(
      "Payments are off on this server, so we can't reach the subscription. Cancel it in the provider's dashboard."
    )
    // One per position the scan reads besides direct literals, so a rename that drops one fails here.
    expect(texts).toContain('Your workspace has no subscription to switch. Upgrade to Paid first.')
    expect(texts).toContain("You can't delete your own account. Ask another platform admin.")
    expect(texts).toContain("You're the last owner. Make someone else an owner before you leave.")
    expect(texts).toContain(
      "This tenant's subscription is with another payment account or mode, so we can't confirm it ended. Ask engineering to check it in that payment account."
    )
    expect(texts).toContain('Credit note X issued for ₹X.')
    expect(texts).toContain("You've reached the limit of X X in X. Try again in X.")
    expect(texts).toContain(
      "We couldn't read the request body as JSON. Fix its syntax, then send it again."
    )
    expect(texts).toContain('Your session expired. Sign in again to continue.')
    expect(texts).toContain('Enter text.')
    expect(texts).toContain('Your account no longer exists. Sign in again to continue.')
    // Each names the support address, built at throw time by a `…Message` function.
    expect(texts).toContain(
      "We couldn't load this workspace's settings. Refresh the page. If it happens again, email X."
    )
    expect(texts).toContain(
      'Our payment provider declined this change. Email X with the error ID if it happens again.'
    )
    expect(texts).toContain(
      'Your subscription is with another payment account. Email X to change it.'
    )
    expect(texts).toContain(
      'Our server hit an error. Try again, and email X with the error ID if it happens again.'
    )
  })

  it('breaks no copy rule in the messages express sends', () => {
    expect(offenders(sourceCopy())).toEqual([])
  })

  it('breaks no copy rule in any email template', () => {
    expect(offenders(templateCopy())).toEqual([])
  })

  it('breaks no copy rule in any staff billing alert', () => {
    const copy = [...Object.entries(ALERTS), ...ALERT_VARIANTS].map(([key, text]) => ({
      where: `alert ${key}`,
      text,
    }))
    expect(offenders(copy)).toEqual([])
  })
})
