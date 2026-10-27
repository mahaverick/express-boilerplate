/**
 * @file The fixed text a tax document PDF prints. The PDF uses the
 * standard Helvetica fonts, which have no rupee sign, so amounts print as
 * `Rs.`. Nothing here depends on configuration, so a re-render of a stored
 * document gives the same bytes.
 */

/**
 * The title of a tax invoice.
 */
export const TAX_INVOICE_TITLE = 'Tax Invoice'

/**
 * The title of a credit note.
 */
export const CREDIT_NOTE_TITLE = 'Credit Note'

/**
 * The reverse-charge line every document prints: the seller pays the tax.
 */
export const REVERSE_CHARGE_SENTENCE = 'Reverse charge: No'

/**
 * The line a credit note prints when it was issued after the s.34(2)
 * deadline, so it gives the buyer no tax reduction.
 */
export const NO_TAX_REDUCTION_SENTENCE = 'No tax reduction (s.34(2))'

/**
 * The last line of every document: it needs no signature.
 */
export const COMPUTER_GENERATED_SENTENCE =
  'This is a computer-generated document and needs no signature.'

/**
 * The PDF's producer and creator. A fixed string, never the app's name, so
 * a renamed app still re-renders a stored document to the same bytes.
 */
export const TAX_DOCUMENT_PDF_PRODUCER = 'GST tax documents'
