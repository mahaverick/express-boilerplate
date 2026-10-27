/**
 * @file The GSTR-1 export's files, their column headers and the fixed
 * cell values, named as the GST offline tool reads them. These are the
 * tool's names, not copy, so the copy check skips this file.
 */

/**
 * The files in the export zip, in the order they are written.
 */
export const GST_EXPORT_FILES = [
  'b2b.csv',
  'b2cs.csv',
  'cdnr.csv',
  'hsn-b2b.csv',
  'hsn-b2c.csv',
  'docs.csv',
  'late-credit-notes.csv',
] as const

/**
 * One of the export's files.
 */
export type GstExportFile = (typeof GST_EXPORT_FILES)[number]

/**
 * The columns of the SAC summaries (table 12), B2B and B2C alike.
 */
const HSN_HEADER = [
  'HSN',
  'Description',
  'UQC',
  'Total Quantity',
  'Total Value',
  'Rate',
  'Taxable Value',
  'Integrated Tax Amount',
  'Central Tax Amount',
  'State/UT Tax Amount',
  'Cess Amount',
] as const

/**
 * Each file's header row.
 */
export const GST_EXPORT_HEADERS = {
  'b2b.csv': [
    'GSTIN/UIN of Recipient',
    'Receiver Name',
    'Invoice Number',
    'Invoice date',
    'Invoice Value',
    'Place Of Supply',
    'Reverse Charge',
    'Applicable % of Tax Rate',
    'Invoice Type',
    'E-Commerce GSTIN',
    'Rate',
    'Taxable Value',
    'Cess Amount',
  ],
  'b2cs.csv': [
    'Type',
    'Place Of Supply',
    'Applicable % of Tax Rate',
    'Rate',
    'Taxable Value',
    'Cess Amount',
    'E-Commerce GSTIN',
  ],
  'cdnr.csv': [
    'GSTIN/UIN of Recipient',
    'Receiver Name',
    'Note Number',
    'Note Date',
    'Note Type',
    'Place Of Supply',
    'Reverse Charge',
    'Note Supply Type',
    'Note Value',
    'Applicable % of Tax Rate',
    'Rate',
    'Taxable Value',
    'Cess Amount',
    'Original Invoice Number',
    'Original Invoice Date',
  ],
  'hsn-b2b.csv': HSN_HEADER,
  'hsn-b2c.csv': HSN_HEADER,
  'docs.csv': ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
  'late-credit-notes.csv': [
    'Note Number',
    'Note Date',
    'Original Invoice Number',
    'Original Invoice Date',
    'GSTIN/UIN of Recipient',
    'Receiver Name',
    'Note Value',
    'Taxable Value',
    'Central Tax Amount',
    'State/UT Tax Amount',
    'Integrated Tax Amount',
  ],
} as const satisfies Record<GstExportFile, readonly string[]>

/**
 * The fixed cell values the GST tool expects.
 */
export const GST_EXPORT_VALUES = {
  reverseCharge: 'N',
  b2bInvoiceType: 'Regular B2B',
  b2csType: 'OE',
  noteType: 'C',
  noteSupplyType: 'Regular B2B',
  hsnDescription: 'Software subscription',
  hsnUqc: 'NA',
  hsnQuantity: '0',
  zeroAmount: '0.00',
  cancelled: '0',
  invoiceSeries: 'Invoices for outward supply',
  creditNoteSeries: 'Credit Note',
} as const

/**
 * Month abbreviations for the tool's `dd-Mmm-yyyy` dates.
 */
export const GST_EXPORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const
