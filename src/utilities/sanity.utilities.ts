// A single trivially-testable export, so the harness itself is under test
// before any real module depends on it. Deleted in plan B2 once real
// utilities are ported.

/**
 * Return the supplied value unchanged.
 * @param value - The value to return.
 * @returns The same value.
 */
export function identity<T>(value: T): T {
  return value
}
