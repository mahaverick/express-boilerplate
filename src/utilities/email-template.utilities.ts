/**
 * @file Shared building blocks for the plain-function email templates under
 * src/templates/email/: HTML escaping and the missing-variable guard. Not a
 * template engine: each template is a TypeScript function building its
 * subject, text and HTML with template literals.
 */

/**
 * The outbound email templates this app renders, from which
 * `EmailTemplateKey` is derived. Each template's `..._TEMPLATE_KEY` is typed
 * against that union, so a typo in a key is a compile error.
 */
export const EMAIL_TEMPLATE_KEYS = [
  'email_verification',
  'password_reset',
  'registration_attempt',
  'password_changed',
  'tenant_invitation',
  'account_setup',
] as const

/**
 * Which template rendered a message: the type of `MailMessage.templateKey`
 * (mailer.service.ts), and what `email_logs.template_key` holds, though that
 * column is a plain `string` in Drizzle.
 */
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]

/**
 * One fully-rendered email: both parts a real client needs, plus the key
 * that produced them.
 *
 * Carries `templateKey` with the body, produced by the same call, so a
 * caller building `{ to, ...renderPasswordResetTemplate(vars) }` cannot send
 * one template's body while logging another's key in `email_logs`.
 */
export interface RenderedEmail {
  templateKey: EmailTemplateKey
  subject: string
  text: string
  html: string
}

/**
 * The five HTML-significant characters and their entities. `as const`, so
 * `HtmlEscapable` is derived from its keys.
 */
const HTML_ESCAPE_TABLE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
} as const

/**
 * One of the five characters `escapeHtmlForEmail`'s regex (`/[&<>"']/g`)
 * can match: exactly `HTML_ESCAPE_TABLE`'s keys, so the cast in
 * `escapeHtmlForEmail` is exact.
 */
type HtmlEscapable = keyof typeof HTML_ESCAPE_TABLE

/**
 * Escape the five HTML-significant characters in `value` so it is safe to
 * interpolate into an email's HTML part — text-node position (between two
 * tags) or attribute position (inside a quoted `href="..."`) alike.
 *
 * One regex pass, not chained `.replaceAll` calls, so an `&` produced by an
 * earlier replacement can never be re-escaped into `&amp;lt;`.
 *
 * The whole guard against a rendered email carrying attacker-controlled
 * markup: every template routes every interpolated value through this before
 * it reaches the HTML part, never the text part, where escaping would show a
 * recipient a literal `&amp;`. The template tests assert escaping on the
 * rendered HTML, not on this function alone.
 * @param value - The raw string to make safe for HTML.
 * @returns `value` with `& < > " '` replaced by their named HTML entities.
 */
export function escapeHtmlForEmail(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => HTML_ESCAPE_TABLE[character as HtmlEscapable])
}

/**
 * Verify every variable a template needs is actually a string before that
 * template interpolates any of them, and throw — naming the first missing
 * one — the moment one is not.
 *
 * A missing variable must fail loudly, never send `Hello undefined,`. The
 * `*Variables` interfaces already require every field, but that does not
 * reach data that bypassed the types (a non-null assertion on a nullable
 * column, a partial object built with `as`, a value passed through
 * `unknown`).
 *
 * Takes the required names explicitly rather than scanning
 * `Object.entries(variables)`: an omitted key never appears in the entries,
 * while `variables[name]` reads `undefined` whether the key is absent or
 * present-but-undefined.
 * @param variables - The template's variables object, exactly as the caller supplied it.
 * @param requiredNames - Every key `variables` must carry as a real string — normally every key of its own interface.
 * @param templateKey - Which template is rendering, named in the thrown error so a failure is traceable to its source.
 * @returns `variables`, unchanged, once every required name has been confirmed present.
 * @throws {Error} Naming the first missing variable, the moment any required value is not a string.
 */
export function requireEmailVariables<T extends object>(
  variables: T,
  requiredNames: ReadonlyArray<keyof T & string>,
  templateKey: EmailTemplateKey
): T {
  for (const name of requiredNames) {
    if (typeof variables[name] !== 'string') {
      // eslint-disable-next-line unicorn/prefer-type-error -- incomplete caller data, not a JavaScript type violation
      throw new Error(
        `Cannot render "${templateKey}" email template: required variable "${name}" is missing.`
      )
    }
  }
  return variables
}
