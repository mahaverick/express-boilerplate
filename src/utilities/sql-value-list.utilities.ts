/**
 * @file Rendering a fixed value list for a model's CHECK constraint.
 */

/**
 * Render a fixed, code-defined value list as SQL literals for a CHECK. A DDL
 * CHECK cannot take bound parameters, so the model splices the result in with
 * `sql.raw`; pass only code constants, never input.
 * @param values - The allowed values.
 * @returns The values quoted and comma-separated.
 */
export function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}
