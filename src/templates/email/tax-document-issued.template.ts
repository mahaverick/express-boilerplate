/**
 * @file The "your tax document is ready" message, sent to the owners when a
 * tax invoice or credit note is issued for their workspace. It carries no
 * amount and no attachment: its one link opens the Billing page, where an
 * owner signs in to download the PDF. The link carries no token, so it mails
 * from the general sender.
 */
import { renderBillingEmail } from '@/templates/email/billing-layout.template'
import {
  requireEmailVariables,
  type EmailTemplateKey,
  type EmailTemplateMeta,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS`. `satisfies`, not an
 * annotation, so it keeps the literal type that `MailMessage`'s union
 * narrows on.
 */
export const TAX_DOCUMENT_ISSUED_TEMPLATE_KEY = 'tax_document_issued' satisfies EmailTemplateKey

/**
 * The variables `renderTaxDocumentIssuedTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface TaxDocumentIssuedVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name, in the body only.
   */
  tenantName: string
  /**
   * Which document: `invoice` or `credit_note`.
   */
  documentType: string
  /**
   * The document's number, such as `INV/26-27/00001`.
   */
  documentNumber: string
  /**
   * The invoice a credit note reduces; an empty string for an invoice.
   */
  invoiceNumber: string
  /**
   * The issue date in IST, such as `27 October 2026`.
   */
  issuedOn: string
  /**
   * The workspace's Billing page. Named `…Link`, not `…Url`: it carries no
   * token, so it is stored and previewed.
   */
  billingLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored for the preview. Never resent.
 */
export const TAX_DOCUMENT_ISSUED_TEMPLATE_META: EmailTemplateMeta<TaxDocumentIssuedVariables> = {
  senderClass: 'general',
  previewVariables: [
    'appName',
    'tenantName',
    'documentType',
    'documentNumber',
    'invoiceNumber',
    'issuedOn',
    'billingLink',
  ],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TaxDocumentIssuedVariables> = [
  'appName',
  'tenantName',
  'documentType',
  'documentNumber',
  'invoiceNumber',
  'issuedOn',
  'billingLink',
]

/**
 * Render the tax document email: plain-text and HTML parts with one button,
 * every value escaped in the HTML part.
 * @param variables - See `TaxDocumentIssuedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When a required variable is missing, or a credit note names no invoice.
 */
export function renderTaxDocumentIssuedTemplate(
  variables: TaxDocumentIssuedVariables
): RenderedEmail {
  const {
    appName,
    tenantName,
    documentType,
    documentNumber,
    invoiceNumber,
    issuedOn,
    billingLink,
  } = requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, TAX_DOCUMENT_ISSUED_TEMPLATE_KEY)
  const isCreditNote = documentType === 'credit_note'
  if (isCreditNote && invoiceNumber === '') {
    throw new Error(`Email template "${TAX_DOCUMENT_ISSUED_TEMPLATE_KEY}" needs invoiceNumber.`)
  }
  return renderBillingEmail({
    templateKey: TAX_DOCUMENT_ISSUED_TEMPLATE_KEY,
    subject: isCreditNote
      ? `Your ${appName} credit note ${documentNumber}`
      : `Your ${appName} tax invoice ${documentNumber}`,
    appName,
    paragraphs: [
      isCreditNote
        ? `Credit note ${documentNumber} for ${tenantName} is ready. It reduces tax invoice ${invoiceNumber} by the amount refunded. It's dated ${issuedOn}.`
        : `Tax invoice ${documentNumber} for ${tenantName} is ready. It's dated ${issuedOn}.`,
    ],
    button: { label: 'Download from Billing', link: billingLink },
  })
}
