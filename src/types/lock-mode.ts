// src/types/lock-mode.ts
//
// FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE lock a
// foreign-key check takes, so an insert that references the locked row does
// not wait for it. A transaction that deletes the row it locked, or changes
// a column a foreign key can reference, takes FOR UPDATE instead.

/**
 * The strength of the row lock a repository lock method takes.
 */
export type RowLockMode = 'update' | 'no key update'
