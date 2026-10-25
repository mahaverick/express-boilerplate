/**
 * @file The shape every billing email shares: a greeting, short paragraphs,
 * one button (none for a notice that asks for no action) and the sign-off, in a plain-text and an HTML part. Each billing
 * template builds its subject and paragraphs as plain text and hands them
 * here, which escapes every one for the HTML part, so no template writes HTML
 * itself. Its links carry no token, so the button's link is also printed for
 * a client that shows no links.
 */
import {
  escapeHtmlForEmail,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * What a billing email says, before rendering.
 */
export interface BillingEmailContent {
  /**
   * The template rendering it.
   */
  templateKey: EmailTemplateKey
  /**
   * The subject: never a user-chosen name.
   */
  subject: string
  /**
   * The product name, for the sign-off.
   */
  appName: string
  /**
   * The paragraphs, in plain text.
   */
  paragraphs: readonly string[]
  /**
   * The one button: its label and its UTM-tagged link. Null for a notice
   * that asks for no action.
   */
  button: { label: string; link: string } | null
}

/**
 * A count with its noun, singular for one.
 * @param count - The count, as digits.
 * @param noun - The singular noun.
 * @returns For example "1 member" or "3 members".
 */
export function countOf(count: string, noun: string): string {
  return count === '1' ? `1 ${noun}` : `${count} ${noun}s`
}

/**
 * Render a billing email's plain-text and HTML parts.
 * @param content - See `BillingEmailContent`.
 * @returns The rendered subject, text and HTML, plus the template's key.
 */
export function renderBillingEmail(content: BillingEmailContent): RenderedEmail {
  const { templateKey, subject, appName, paragraphs, button } = content

  const text = [
    'Hi,',
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(button === null ? [] : [`${button.label}:`, '', button.link, '']),
    `— The ${appName} team`,
  ].join('\n')

  const buttonHtml =
    button === null
      ? ''
      : `    <p><a href="${escapeHtmlForEmail(button.link)}">${escapeHtmlForEmail(button.label)}</a></p>
    <p>Or paste this link into your browser: ${escapeHtmlForEmail(button.link)}</p>
`
  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi,</p>
${paragraphs.map((paragraph) => `    <p>${escapeHtmlForEmail(paragraph)}</p>`).join('\n')}
${buttonHtml}    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return { templateKey, subject, text, html }
}
