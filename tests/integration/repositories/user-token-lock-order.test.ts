// tests/integration/repositories/user-token-lock-order.test.ts
//
// The four bulk revokers lock the rows they revoke in id order, whatever plan
// or physical row layout Postgres uses (user-token.repository.ts's header).
//
// The property test pins that property; it does not reproduce a production
// interleaving. Two writers deadlock only if they visit shared rows in
// opposite orders. On today's schema every plan visits in physical order, so
// the test builds the one layout where physical order and index order
// disagree: live row `a` is HOT-updated onto a later slot of `b`'s page. It
// then forces writer A onto a sequential scan (visits b, a) and writer B onto
// an index scan (visits a, b), while a third connection holds b. Writers that
// lock in scan order deadlock (40P01); writers that lock in id order queue.
//
// The plan-shape test reads EXPLAIN for the SQL each writer really sends:
// LockRows must sit directly above a node that yields id order. The schema
// guard fails when an index would make the unordered writers' orders differ
// on an ordinary layout.
//
// The MUTATION_PROOF tests are DELIBERATELY red: each swaps the writers for
// stand-ins that update by their predicate directly, without locking in id
// order, and keeps the real test's assertions.
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/user-token-lock-order.test.ts   # red
//   pnpm exec vitest run tests/integration/repositories/user-token-lock-order.test.ts                    # green
import { randomBytes, randomUUID } from 'node:crypto'
import { eq, sql, type Logger, type SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { userTokenModel, type TokenPurpose } from '@/database/models/user-token.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql as rawSql, type DbExecutor } from '@/services/database.service'
import { backendPid, deferred, waitForBlocked } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * A single-connection client and its drizzle wrapper. The pool has two
 * connections, and the property test holds three transactions open.
 * @param logger - Records each statement drizzle sends, when given.
 * @returns The client and the drizzle instance over it.
 */
function dedicatedConnection(logger?: Logger): { client: postgres.Sql; conn: typeof db } {
  const client = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} })
  return { client, conn: drizzle(client, logger ? { logger } : {}) }
}

const connectionA = dedicatedConnection()
const connectionB = dedicatedConnection()
const connectionC = dedicatedConnection()

/**
 * A statement drizzle sent, as its logger saw it.
 */
interface CapturedStatement {
  query: string
  parameters: unknown[]
}

const captured: CapturedStatement[] = []
const capturing = dedicatedConnection({
  logQuery: (query, parameters) => {
    captured.push({ query, parameters })
  },
})

const createdUserIds: string[] = []

afterEach(async () => {
  if (createdUserIds.length === 0) return
  await rawSql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

afterAll(async () => {
  await Promise.all(
    [connectionA, connectionB, connectionC, capturing].map(({ client }) =>
      client.end({ timeout: 5 })
    )
  )
})

/**
 * The sets every stand-in writes, as the real writers write them through `touched`.
 * @returns The revoke's column values.
 */
function revokedNow(): { revokedAt: SQL; updatedAt: SQL } {
  return { revokedAt: sql`now()`, updatedAt: sql`now()` }
}

/**
 * The distinct non-null session ids of revoked rows.
 * @param rows - The rows an UPDATE returned.
 * @returns The ids, deduplicated.
 */
function distinctSessionIds(rows: { sessionId: string | null }[]): string[] {
  const ids = rows
    .map((row) => row.sessionId)
    .filter((sessionId): sessionId is string => sessionId !== null)
  return [...new Set(ids)]
}

/**
 * A `revokeAllForSession` stand-in that updates by its predicate directly.
 * @param sessionId - The session.
 * @param executor - Where to run the query.
 * @returns Resolves once the rows are revoked.
 */
async function unorderedRevokeAllForSession(
  sessionId: string,
  executor: DbExecutor = db
): Promise<void> {
  await executor
    .update(userTokenModel)
    .set(revokedNow())
    .where(
      sql`${userTokenModel.sessionId} = ${sessionId} and ${userTokenModel.revokedAt} is null and ${userTokenModel.deletedAt} is null`
    )
}

/**
 * A `revokeAllForUser` stand-in that updates by its predicate directly.
 * @param userId - The user.
 * @param executor - Where to run the query.
 * @returns The distinct session ids revoked.
 */
async function unorderedRevokeAllForUser(
  userId: string,
  executor: DbExecutor = db
): Promise<string[]> {
  const rows = await executor
    .update(userTokenModel)
    .set(revokedNow())
    .where(
      sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.revokedAt} is null and ${userTokenModel.deletedAt} is null`
    )
    .returning({ sessionId: userTokenModel.sessionId })
  return distinctSessionIds(rows)
}

/**
 * A `revokeAllForUserExceptSession` stand-in that updates by its predicate directly.
 * @param userId - The user.
 * @param sessionId - The session to spare.
 * @param executor - Where to run the query.
 * @returns The distinct session ids revoked.
 */
async function unorderedRevokeAllForUserExceptSession(
  userId: string,
  sessionId: string,
  executor: DbExecutor = db
): Promise<string[]> {
  const rows = await executor
    .update(userTokenModel)
    .set(revokedNow())
    .where(
      sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.sessionId} is distinct from ${sessionId} and ${userTokenModel.revokedAt} is null and ${userTokenModel.deletedAt} is null`
    )
    .returning({ sessionId: userTokenModel.sessionId })
  return distinctSessionIds(rows)
}

/**
 * A `revokeAllForUserAndPurpose` stand-in that updates by its predicate directly.
 * @param userId - The user.
 * @param purpose - The purpose.
 * @param executor - Where to run the query.
 * @returns Resolves once the rows are revoked.
 */
async function unorderedRevokeAllForUserAndPurpose(
  userId: string,
  purpose: TokenPurpose,
  executor: DbExecutor = db
): Promise<void> {
  await executor
    .update(userTokenModel)
    .set(revokedNow())
    .where(
      sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.purpose} = ${purpose} and ${userTokenModel.revokedAt} is null and ${userTokenModel.deletedAt} is null`
    )
}

/**
 * Run `run` with all four writers swapped for their unordered stand-ins.
 * @param run - The test body.
 * @returns Resolves once `run` settles and every writer is restored.
 */
async function withUnorderedWriters(run: () => Promise<void>): Promise<void> {
  const prototype = UserTokenRepository.prototype
  await withMutatedMethod(prototype, 'revokeAllForSession', unorderedRevokeAllForSession, () =>
    withMutatedMethod(prototype, 'revokeAllForUser', unorderedRevokeAllForUser, () =>
      withMutatedMethod(
        prototype,
        'revokeAllForUserExceptSession',
        unorderedRevokeAllForUserExceptSession,
        () =>
          withMutatedMethod(
            prototype,
            'revokeAllForUserAndPurpose',
            unorderedRevokeAllForUserAndPurpose,
            run
          )
      )
    )
  )
}

/**
 * A row's physical position.
 * @param id - The token row's id.
 * @returns Its page and line pointer.
 */
async function ctidOf(id: string): Promise<[number, number]> {
  const [row] = await rawSql<{ ctid: string }[]>`
    select ctid::text as ctid from user_tokens where id = ${id}
  `
  const match = /\((\d+),(\d+)\)/.exec(row?.ctid ?? '')
  if (!match) throw new Error(`no ctid for ${id}`)
  return [Number(match[1]), Number(match[2])]
}

/**
 * Insert a live refresh row.
 * @param userId - The user.
 * @param sessionId - The session.
 * @returns The row's id.
 */
async function insertRefresh(userId: string, sessionId: string): Promise<string> {
  const [row] = await db
    .insert(userTokenModel)
    .values({
      userId,
      purpose: 'refresh',
      sessionId,
      sessionStartedAt: new Date(),
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: userTokenModel.id })
  if (!row) throw new Error('insert returned no row')
  return row.id
}

/**
 * Two live rows of one session whose physical order (b, a) disagrees with
 * their index order (a, b): a is HOT-updated onto a later slot of b's page.
 * No application path updates a live row without revoking it; this is the
 * layout such a path, or a composite index, would create.
 * @returns The user, the session and the two row ids.
 * @throws {Error} When no attempt produces the layout.
 */
async function divergentPair(): Promise<{
  userId: string
  sessionId: string
  a: string
  b: string
}> {
  // A fresh user per attempt: a failed attempt's rows must not join the next one's revoke set.
  for (let pair = 0; pair < 10; pair += 1) {
    const user = await userRepository.create({
      email: `lock-order-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    const sessionId = randomUUID()
    const a = await insertRefresh(user.id, sessionId)
    const b = await insertRefresh(user.id, sessionId)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .update(userTokenModel)
        .set({ updatedAt: sql`now()` })
        .where(eq(userTokenModel.id, a))
      const [[pageA, slotA], [pageB, slotB]] = [await ctidOf(a), await ctidOf(b)]
      if (pageA === pageB && slotA > slotB) return { userId: user.id, sessionId, a, b }
    }
  }
  throw new Error('precondition: could not HOT-relocate a past b on one page')
}

/**
 * How one actor's statement settled.
 */
type Outcome = { ok: true } | { ok: false; code: string | undefined; message: string }

/**
 * One transaction on a dedicated connection.
 */
interface Actor {
  pid: Promise<number>
  statement: Promise<Outcome>
  done: Promise<unknown>
}

/**
 * Thrown to roll an actor's transaction back once the test releases it.
 */
class Rollback extends Error {}

/**
 * Run `work` in a transaction on `conn` with the given planner settings,
 * report its outcome as soon as it settles, and hold the transaction open
 * (as a locked caller would) until `end` resolves; then roll back.
 * @param conn - The actor's dedicated connection.
 * @param planner - `SET LOCAL` settings, e.g. `enable_seqscan = off`.
 * @param work - The statement under test.
 * @param end - Resolved by the test to end the transaction.
 * @returns The actor's backend pid, statement outcome and transaction.
 */
function actor(
  conn: typeof db,
  planner: readonly string[],
  work: (tx: DbExecutor) => Promise<unknown>,
  end: Promise<void>
): Actor {
  const pid = deferred<number>()
  const statement = deferred<Outcome>()
  const done = (async (): Promise<void> => {
    try {
      await conn.transaction(async (tx) => {
        for (const setting of planner) await tx.execute(sql.raw(`set local ${setting}`))
        pid.resolve(await backendPid(tx))
        try {
          await work(tx)
          statement.resolve({ ok: true })
        } catch (error) {
          const { code, cause } = error as { code?: string; cause?: { code?: string } }
          statement.resolve({ ok: false, code: code ?? cause?.code, message: String(error) })
          throw error
        }
        await end
        throw new Rollback()
      })
    } catch {
      // Always rolled back; the statement's own outcome is in `statement`.
    }
  })()
  return { pid: pid.promise, statement: statement.promise, done }
}

/**
 * Race revokeAllForUser (sequential scan) against revokeAllForSession (index
 * scan) on the divergent layout, with a third connection holding b.
 * @returns Both writers' outcomes.
 */
async function raceOnDivergentLayout(): Promise<{ A: Outcome; B: Outcome }> {
  const { userId, sessionId, b } = await divergentPair()
  const endA = deferred()
  const endB = deferred()
  const endC = deferred()
  const actors: Actor[] = []
  try {
    // C holds b.
    const holder = actor(
      connectionC.conn,
      [],
      (tx) => tx.execute(sql`select id from user_tokens where id = ${b} for update`),
      endC.promise
    )
    actors.push(holder)
    await holder.statement

    // A's sequential scan meets b first and blocks on C.
    const writerA = actor(
      connectionA.conn,
      ['enable_indexscan = off', 'enable_bitmapscan = off'],
      (tx) => userTokenRepository.revokeAllForUser(userId, tx),
      endA.promise
    )
    actors.push(writerA)
    expect(await waitForBlocked(await writerA.pid, writerA.statement)).toBe(true)

    // B's index scan meets a first. Unordered, it takes a and queues on b;
    // ordered, it queues on the first id A holds. Either way it blocks.
    const writerB = actor(
      connectionB.conn,
      ['enable_seqscan = off', 'enable_bitmapscan = off'],
      (tx) => userTokenRepository.revokeAllForSession(sessionId, tx),
      endB.promise
    )
    actors.push(writerB)
    expect(await waitForBlocked(await writerB.pid, writerB.statement)).toBe(true)

    endC.resolve()
    await holder.done
    const outcomeA = await writerA.statement
    endA.resolve()
    await writerA.done
    const outcomeB = await writerB.statement
    return { A: outcomeA, B: outcomeB }
  } finally {
    endC.resolve()
    endA.resolve()
    endB.resolve()
    await Promise.allSettled(actors.map((running) => running.done))
  }
}

describe('bulk token revokers lock rows in id order', () => {
  it('revokeAllForUser (sequential scan) and revokeAllForSession (index scan) never deadlock', async () => {
    expect(await raceOnDivergentLayout()).toEqual({ A: { ok: true }, B: { ok: true } })
  })

  // DELIBERATELY red under MUTATION_PROOF=1: writers that lock in scan order deadlock.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the lock-order test against writers that lock in scan order',
    async () => {
      await withUnorderedWriters(async () => {
        expect(await raceOnDivergentLayout()).toEqual({ A: { ok: true }, B: { ok: true } })
      })
    }
  )
})

/**
 * One node of an `EXPLAIN (FORMAT JSON)` plan, with the fields read here.
 */
interface PlanNode {
  'Node Type': string
  'Sort Key'?: string[]
  'Index Name'?: string
  'Scan Direction'?: string
  Plans?: PlanNode[]
}

// The sort key of the revokers' inner scan of user_tokens, however Postgres aliases it.
const ID_SORT_KEY = /^user_tokens(?:_\d+)?\.id$/

const WRITERS: { name: string; run: (executor: DbExecutor) => Promise<unknown> }[] = [
  {
    name: 'revokeAllForSession',
    run: (executor) => userTokenRepository.revokeAllForSession(randomUUID(), executor),
  },
  {
    name: 'revokeAllForUser',
    run: (executor) => userTokenRepository.revokeAllForUser(randomUUID(), executor),
  },
  {
    name: 'revokeAllForUserExceptSession',
    run: (executor) =>
      userTokenRepository.revokeAllForUserExceptSession(randomUUID(), randomUUID(), executor),
  },
  {
    name: 'revokeAllForUserAndPurpose',
    run: (executor) =>
      userTokenRepository.revokeAllForUserAndPurpose(randomUUID(), 'email_verification', executor),
  },
]

const PLANNERS: { label: string; settings: readonly string[] }[] = [
  { label: 'the default plan', settings: [] },
  {
    label: 'a forced sequential scan',
    settings: ['enable_indexscan = off', 'enable_bitmapscan = off'],
  },
  { label: 'a forced index scan', settings: ['enable_seqscan = off', 'enable_bitmapscan = off'] },
]

/**
 * The UPDATE a writer sends, captured by running it for ids that match no row.
 * @param run - The writer.
 * @returns Its SQL text and bound parameters.
 */
async function capturedUpdate(
  run: (executor: DbExecutor) => Promise<unknown>
): Promise<CapturedStatement> {
  captured.length = 0
  await run(capturing.conn)
  const update = captured.find(({ query }) => query.startsWith('update "user_tokens"'))
  if (!update) throw new Error('the writer sent no UPDATE of user_tokens')
  return update
}

/**
 * The JSON plan of a captured statement under the given planner settings.
 * @param statement - The statement and its parameters.
 * @param settings - `SET LOCAL` settings for the EXPLAIN's transaction.
 * @returns The plan's root node.
 */
async function planOf(
  statement: CapturedStatement,
  settings: readonly string[]
): Promise<PlanNode> {
  const rows = await capturing.client.begin(async (tx) => {
    for (const setting of settings) await tx.unsafe(`set local ${setting}`)
    return tx.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      `explain (format json) ${statement.query}`,
      statement.parameters as postgres.ParameterOrJSON<never>[]
    )
  })
  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan
  if (!plan) throw new Error('EXPLAIN returned no plan')
  return plan
}

/**
 * Every LockRows node in a plan.
 * @param node - The plan's root.
 * @returns The LockRows nodes, outermost first.
 */
function lockRowsNodes(node: PlanNode): PlanNode[] {
  const own = node['Node Type'] === 'LockRows' ? [node] : []
  return [...own, ...(node.Plans ?? []).flatMap((child) => lockRowsNodes(child))]
}

/**
 * Whether a node yields rows in id order: a sort on id, or a forward scan of the primary key.
 * @param node - LockRows' input.
 * @returns True when the node yields id order.
 */
function isIdOrdered(node: PlanNode | undefined): boolean {
  if (node?.['Node Type'] === 'Sort') {
    const keys = node['Sort Key'] ?? []
    return keys.length === 1 && ID_SORT_KEY.test(keys[0] ?? '')
  }
  return (
    node?.['Node Type'] === 'Index Scan' &&
    node['Index Name'] === 'user_tokens_pkey' &&
    node['Scan Direction'] === 'Forward'
  )
}

/**
 * Assert that a writer's plan locks through one LockRows fed in id order.
 * @param run - The writer.
 * @param settings - The planner settings to plan under.
 */
async function expectIdOrderedLocking(
  run: (executor: DbExecutor) => Promise<unknown>,
  settings: readonly string[]
): Promise<void> {
  const plan = await planOf(await capturedUpdate(run), settings)
  const lockRows = lockRowsNodes(plan)
  expect(lockRows, JSON.stringify(plan)).toHaveLength(1)
  expect(lockRows[0]?.Plans, JSON.stringify(plan)).toHaveLength(1)
  expect(isIdOrdered(lockRows[0]?.Plans?.[0]), JSON.stringify(plan)).toBe(true)
}

describe('each bulk revoker locks through LockRows fed in id order', () => {
  describe.each(PLANNERS)('under $label', ({ settings }) => {
    it.each(WRITERS)('$name', async ({ run }) => {
      await expectIdOrderedLocking(run, settings)
    })
  })

  // DELIBERATELY red under MUTATION_PROOF=1: an UPDATE by predicate has no LockRows.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the plan test against writers that lock in scan order',
    async () => {
      await withUnorderedWriters(async () => {
        for (const { run } of WRITERS) await expectIdOrderedLocking(run, [])
      })
    }
  )
})

/**
 * One index on user_tokens, as the guard reads it.
 */
interface IndexShape {
  indexName: string
  keyColumns: number
  leadingColumn: string | null
}

const GUARD_MESSAGE =
  'A multi-column index leading with user_id or session_id orders equal keys by its next ' +
  'column, not by row position, so the revokers would scan shared rows in different orders. ' +
  'They lock in id order (UserTokenRepository.lockedIds); that is what keeps this safe.'

/**
 * Every index on user_tokens, read in a transaction that is rolled back.
 * @param probeDdl - A statement run first in that transaction, e.g. a CREATE INDEX.
 * @returns Each index's name, key column count and leading column.
 */
async function userTokenIndexes(probeDdl?: string): Promise<IndexShape[]> {
  // A holder object: TypeScript does not see assignments made inside the callback.
  const result: { indexes?: IndexShape[] } = {}
  try {
    await rawSql.begin(async (tx) => {
      if (probeDdl) await tx.unsafe(probeDdl)
      const rows = await tx<IndexShape[]>`
        select c.relname as "indexName", i.indnkeyatts as "keyColumns", a.attname as "leadingColumn"
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
        where i.indrelid = 'user_tokens'::regclass
        order by c.relname
      `
      result.indexes = [...rows]
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  if (!result.indexes) throw new Error('the index query did not run')
  return result.indexes
}

/**
 * The indexes that would let two revokers scan shared rows in different orders.
 * @param indexes - Every index on user_tokens.
 * @returns Their names.
 */
function orderChangingIndexes(indexes: IndexShape[]): string[] {
  return indexes
    .filter(
      ({ keyColumns, leadingColumn }) =>
        keyColumns > 1 && (leadingColumn === 'user_id' || leadingColumn === 'session_id')
    )
    .map(({ indexName }) => indexName)
}

describe('user_tokens schema guard', () => {
  it('has no multi-column index leading with user_id or session_id', async () => {
    const indexes = await userTokenIndexes()

    // The query sees the single-column indexes the revokers scan today.
    expect(indexes).toEqual(
      expect.arrayContaining([
        { indexName: 'user_tokens_user_id_idx', keyColumns: 1, leadingColumn: 'user_id' },
        { indexName: 'user_tokens_session_id_idx', keyColumns: 1, leadingColumn: 'session_id' },
      ])
    )
    expect(orderChangingIndexes(indexes), GUARD_MESSAGE).toEqual([])
  })

  // Always on: the guard does flag the index it exists for.
  it('flags a composite index leading with user_id', async () => {
    const indexes = await userTokenIndexes(
      'create index user_tokens_lock_order_probe_idx on user_tokens (user_id, purpose)'
    )

    expect(orderChangingIndexes(indexes)).toEqual(['user_tokens_lock_order_probe_idx'])
  })
})
