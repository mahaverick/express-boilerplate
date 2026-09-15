// src/utilities/email-template.utilities.ts
//
// Shared building blocks for the three plain-function email templates under
// src/templates/email/ — NOT a template engine. task-3-brief.md's
// Controller addendum is explicit that this task must not build one (no
// `{{placeholder}}` parser, no partials, no inheritance): three emails do
// not justify that surface, so each template is a real TypeScript function
// that builds its subject/text/html with ordinary template literals. What
// lives here is only the two small, genuinely-shared concerns every one of
// those functions needs: escaping a value before it lands in the HTML part,
// and refusing to render at all when a required value is missing.
//
/**
 * The three outbound email templates this app renders — the single source
 * of truth `EmailTemplateKey` is derived from, below. Closes the deferred
 * item from Task 2 (mailer.service.ts's `MailMessage.templateKey` shipped
 * as an unconstrained `string` because these keys did not exist yet — see
 * that file's own comment). Paired the same way
 * `EMAIL_LOG_STATUSES`/`EmailLogStatus` are paired in email-log.model.ts:
 * one array is the single source of truth, the union type is derived from
 * it, and every template's own `..._TEMPLATE_KEY` constant is typed AGAINST
 * that union rather than left as a bare string literal — so a typo
 * (`'email_verifcation'`) is a compile error, not a message that silently
 * renders under a key nothing ever matches.
 */
export const EMAIL_TEMPLATE_KEYS = [
  'email_verification',
  'password_reset',
  'registration_attempt',
] as const

/**
 * Which of this app's three outbound email templates rendered a given
 * message. Closes `MailMessage.templateKey` (mailer.service.ts) from an
 * unconstrained `string` into this union — the deferred item from Task 2's
 * addendum — and is also what `email_logs.template_key` (email-log.model.ts)
 * is meant to hold, though that column's own type stays a plain `string` at
 * the Drizzle layer (see email-log.repository.ts's header comment on why
 * `record()` still normalizes it defensively rather than leaning on this
 * type alone).
 */
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]

/**
 * One fully-rendered email: both parts a real client needs, plus the key
 * that produced them.
 *
 * Carries `templateKey` alongside `subject`/`text`/`html` — one step past
 * what task-3-brief.md's addendum literally asks for — so a future caller
 * builds a `MailMessage` as `{ to, ...renderPasswordResetTemplate(vars) }`
 * and can never accidentally send one template's body while logging a
 * different template's key in `email_logs` (email-log.model.ts): the two
 * are produced together, by the same call, and cannot drift apart the way
 * two independently-typed arguments could.
 */
export interface RenderedEmail {
  templateKey: EmailTemplateKey
  subject: string
  text: string
  html: string
}

// `as const` (not `Readonly<Record<string, string>>`) so `HtmlEscapable`
// below can be derived from the table's own keys — the five characters
// escapeHtmlForEmail's regex can ever match, and nothing else. That is what
// makes the cast inside escapeHtmlForEmail a real narrowing instead of an
// unreachable `?? character` fallback masking a lookup that could return
// undefined for any input the regex could actually produce.
const HTML_ESCAPE_TABLE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
} as const

/**
 * One of the five characters `escapeHtmlForEmail`'s regex (`/[&<>"']/g`)
 * can ever match — exactly `HTML_ESCAPE_TABLE`'s own key set, derived from
 * it rather than retyped, so the two can never drift apart.
 */
type HtmlEscapable = keyof typeof HTML_ESCAPE_TABLE

/**
 * Escape the five HTML-significant characters in `value` so it is safe to
 * interpolate into an email's HTML part — text-node position (between two
 * tags) or attribute position (inside a quoted `href="..."`) alike.
 *
 * A single regex-driven pass, not five chained `.replaceAll` calls in
 * sequence. Both approaches are correct IF the `&` replacement runs first —
 * every other replacement's own output (`&lt;`, `&gt;`, ...) contains a `&`
 * that a later `&`-replacement pass would re-escape into `&amp;lt;` — but a
 * single pass over the original string, replacing each matched character
 * once via a regex callback, makes that ordering bug structurally
 * unreachable instead of merely avoided by writing the calls in the right
 * order.
 *
 * This is the ENTIRE structural guarantee against a rendered email
 * executing attacker-controlled markup: every template below routes every
 * interpolated value through this function before it reaches the html part
 * (never the text part — plain text has no markup to execute, and escaping
 * it would show a recipient literal `&amp;` instead of `&`). See each
 * template's own test file for the escaping proof — asserted against the
 * rendered `.html` output, not against this function in isolation, per
 * task-3-brief.md's addendum ("assert on the rendered output, not on the
 * escaping helper in isolation").
 * @param value - The raw string to make safe for HTML.
 * @returns `value` with `& < > " '` replaced by their named HTML entities.
 */
export function escapeHtmlForEmail(value: string): string {
  // The cast is exact, not defensive: the regex character class and the
  // table's key set name the identical five characters (HtmlEscapable's own
  // comment), so every value this callback ever receives is a valid key —
  // there is no "else" branch to fall back to, and no `?? character` this
  // function would otherwise need to keep untested and unreachable.
  return value.replaceAll(/[&<>"']/g, (character) => HTML_ESCAPE_TABLE[character as HtmlEscapable])
}

/**
 * Verify every variable a template needs is actually a string before that
 * template interpolates any of them, and throw — naming the first missing
 * one — the moment one is not.
 *
 * This is the guard behind task-3-brief.md's addendum requirement: "a
 * missing variable must fail loudly... `Hello undefined,` in a
 * password-reset email is the canonical example." Every template's own
 * `*Variables` interface already declares each field required (`firstName:
 * string`, never `string | undefined`), so ordinary, correctly-typed
 * TypeScript code can never construct a call this function would reject —
 * but that compile-time guarantee does not reach a caller building the
 * object from data this app does not fully control at the type level (a
 * nullable database column coerced with a non-null assertion, a partial
 * object built with `as`, a value threaded through `unknown` at a module
 * boundary). This function is the last point before that value reaches a
 * sent, user-facing email, and it does not trust the caller's types any
 * more than `EmailLogRepository.record` (email-log.repository.ts) trusts
 * that an `errorCode` it receives already matches its expected shape.
 *
 * Takes the explicit list of required names, rather than
 * `Object.entries(variables)` — that distinction is load-bearing, not
 * stylistic: a caller who OMITS a key entirely (`{ resetUrl, appName } as
 * PasswordResetVariables`, `firstName` never set at all) produces an object
 * whose own entries never mention `firstName` in the first place, so an
 * entries-based scan would never see it missing and would let it through to
 * render as `Hello undefined,` — the exact canonical failure this function
 * exists to prevent. Checking each name explicitly (`variables[name]`)
 * reads `undefined` identically whether the key is present-but-undefined or
 * absent altogether, so both shapes are caught the same way.
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
      // eslint-disable-next-line unicorn/prefer-type-error -- this is an application-level "the caller's data is incomplete" error, not a JavaScript type violation; a TypeError would misleadingly suggest the latter to anything that branches on error class
      throw new Error(
        `Cannot render "${templateKey}" email template: required variable "${name}" is missing.`
      )
    }
  }
  return variables
}
