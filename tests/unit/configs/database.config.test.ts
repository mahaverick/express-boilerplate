// tests/unit/configs/database.config.test.ts
//
// The pool options as a pure function: database.service.ts opens its pool at
// module scope, and .env.test's DB_POOL_MAX=2 matches the value the pool
// used before it read DB_POOL_MAX, so only this proves both variables are read.
import { describe, expect, it } from 'vitest'
import { databaseClientOptions } from '@/configs/database.config'

describe('databaseClientOptions', () => {
  it('sizes the pool from DB_POOL_MAX', () => {
    expect(databaseClientOptions({ DB_POOL_MAX: 7, DB_STATEMENT_TIMEOUT_MS: 0 }).max).toBe(7)
  })

  it('sends DB_STATEMENT_TIMEOUT_MS as the statement_timeout connection parameter', () => {
    expect(
      databaseClientOptions({ DB_POOL_MAX: 10, DB_STATEMENT_TIMEOUT_MS: 1500 }).connection
    ).toEqual({ statement_timeout: 1500 })
  })

  it('sends no statement_timeout when DB_STATEMENT_TIMEOUT_MS is 0, leaving the server default', () => {
    expect(
      databaseClientOptions({ DB_POOL_MAX: 10, DB_STATEMENT_TIMEOUT_MS: 0 })
    ).not.toHaveProperty('connection')
  })

  it('keeps the fixed options: idle and connect timeouts, prepared statements off', () => {
    expect(databaseClientOptions({ DB_POOL_MAX: 10, DB_STATEMENT_TIMEOUT_MS: 0 })).toEqual({
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    })
  })
})
