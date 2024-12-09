import { AnyColumn, isNull } from 'drizzle-orm'

export abstract class BaseRepository {
  /**
   * Check if a column is protected with soft delete
   *
   * @param {AnyColumn} deletedAtColumn - Column to check
   * @returns {boolean}
   */
  protected withSoftDelete(deletedAtColumn: AnyColumn) {
    return isNull(deletedAtColumn)
  }

  /**
   * Omits sensitive columns from the result
   * @param {string[]} columns - Columns to omit
   *
   * @returns {{ [key: string]: boolean }} - Omitted columns
   */
  protected omitSensitiveColumns(...columns: string[]): { [key: string]: boolean } {
    const omittedColumnMap: { [key: string]: boolean } = {}

    columns.forEach((column: string) => {
      omittedColumnMap[column] = false
    })
    return omittedColumnMap
  }

  /**
   * Omits User model's sensitive columns from the result
   * This method is overloaded to allow omitting additional columns
   *
   * @param {string[]} columns - Columns to omit
   *
   * @returns {{ [key: string]: boolean }} - Omitted columns
   */
  protected omitUserSensitiveColumns(...columns: string[] | []): { [key: string]: boolean } {
    return this.omitSensitiveColumns(
      'id',
      'password',
      'emailVerifiedAt',
      'phoneVerifiedAt',
      'deletedAt',
      'active',
      ...columns
    )
  }

  /**
   * Get current timestamp
   *
   * @returns {Date}
   */
  protected getCurrentTimestamp() {
    return new Date()
  }
}
