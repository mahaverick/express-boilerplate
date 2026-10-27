/**
 * @file The tax document email: both subjects, both bodies, a link-only
 * message with no amount, HTML escaping, the one button and a missing
 * variable naming itself.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  renderTaxDocumentIssuedTemplate,
  type TaxDocumentIssuedVariables,
} from '@/templates/email/tax-document-issued.template'

const LINK =
  'https://app.example.test/settings/workspace/acme/billing?utm_source=email&utm_medium=email&utm_campaign=tax_document_issued&utm_content=primary_button'

const INVOICE: TaxDocumentIssuedVariables = {
  appName: 'Acme',
  tenantName: 'Northwind',
  documentType: 'invoice',
  documentNumber: 'INV/26-27/00001',
  invoiceNumber: '',
  issuedOn: '27 October 2026',
  billingLink: LINK,
}

const CREDIT_NOTE: TaxDocumentIssuedVariables = {
  ...INVOICE,
  documentType: 'credit_note',
  documentNumber: 'CN/26-27/00001',
  invoiceNumber: 'INV/26-27/00001',
}

/**
 * Text with the document numbers and the date removed.
 * @param text - A rendered part.
 * @returns The text without them.
 */
function withoutNumbersAndDate(text: string): string {
  return text
    .replaceAll(/(?:INV|CN)\/\d\d-\d\d\/\d{5}/g, '')
    .replaceAll('27 October 2026', '')
    .replaceAll(/utm_[a-z]+=[a-z_]+/g, '')
}

describe('renderTaxDocumentIssuedTemplate', () => {
  it('names the tax invoice in the subject and body', () => {
    const email = renderTaxDocumentIssuedTemplate(INVOICE)
    expect(email.templateKey).toBe('tax_document_issued')
    expect(email.subject).toBe('Your Acme tax invoice INV/26-27/00001')
    expect(email.text).toContain(
      "Tax invoice INV/26-27/00001 for Northwind is ready. It's dated 27 October 2026."
    )
    expect(email.html).toContain('Tax invoice INV/26-27/00001 for Northwind is ready.')
    expect(email.html).toContain('dated 27 October 2026.')
  })

  it('names the credit note, the invoice it reduces and the date', () => {
    const email = renderTaxDocumentIssuedTemplate(CREDIT_NOTE)
    expect(email.subject).toBe('Your Acme credit note CN/26-27/00001')
    expect(email.text).toContain(
      "Credit note CN/26-27/00001 for Northwind is ready. It reduces tax invoice INV/26-27/00001 by the amount refunded. It's dated 27 October 2026."
    )
    expect(email.html).toContain('It reduces tax invoice INV/26-27/00001 by the amount refunded.')
  })

  it.each([INVOICE, CREDIT_NOTE])('carries no amount and no digit but the number and date', (v) => {
    const email = renderTaxDocumentIssuedTemplate(v)
    for (const part of [email.subject, email.text]) {
      expect(part).not.toMatch(/Rs\.|₹/)
      expect(withoutNumbersAndDate(part)).not.toMatch(/\d/)
    }
    expect(email.html).not.toMatch(/Rs\.|₹/)
  })

  it('has one button to the billing link, in both parts', () => {
    const email = renderTaxDocumentIssuedTemplate(INVOICE)
    expect(email.text).toContain('Download from Billing')
    expect(email.text).toContain(LINK)
    expect(email.html).toContain('Download from Billing')
    expect(email.html.match(/href="https:\/\/app\.example\.test/g)).toHaveLength(1)
  })

  it('escapes the workspace name in the html and keeps it out of the subject', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const email = renderTaxDocumentIssuedTemplate({ ...CREDIT_NOTE, tenantName: payload })
    expect(email.html).not.toContain(payload)
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(email.subject).not.toContain('img')
  })

  it('throws, naming the variable, when one is missing', () => {
    const { billingLink: _omitted, ...rest } = INVOICE
    expect(() =>
      renderTaxDocumentIssuedTemplate(rest as unknown as TaxDocumentIssuedVariables)
    ).toThrow('billingLink')
  })

  it('refuses a credit note that names no invoice', () => {
    expect(() => renderTaxDocumentIssuedTemplate({ ...CREDIT_NOTE, invoiceNumber: '' })).toThrow(
      'invoiceNumber'
    )
  })
})
