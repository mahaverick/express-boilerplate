// src/repositories/tenant.repository.ts
//
// `findBySlug`/`findBySlugOrId`/`findActiveBySlug` build their own
// conditions and go through `this.selectOne` — the same
// `BaseRepository.scope`-based shape `UserRepository.findByEmail` uses —
// so none of them can drift from `findById`'s soft-delete behaviour.
//
// `create` is the one method that is NOT a thin wrapper over
// `BaseRepository`'s inherited flow: creating a tenant also creates its
// settings row and its creator's owner membership, atomically, so a
// failure partway through (e.g. a slug collision) leaves no orphaned
// tenant with no settings or no owner. It therefore does not call
// `BaseRepository.create` (nor `TenantSettingsRepository`/
// `UserMembershipRepository` — see this method's own comment for why) and
// instead writes all three rows directly against a `db.transaction()`'s
// `tx` handle, mirroring `register()`'s user+auth_provider transaction in
// auth.controller.ts.
//
// Overriding `create` still has to satisfy `BaseRepository`'s own
// (non-abstract) `create(values, ...): Promise<Tenant>` signature — this
// class's override accepts `CreateTenantInput` (a strict superset of
// `NewTenant`, adding only `ownerId`, which does not exist as a tenants
// column) and still returns `Promise<Tenant>`, so it type-checks as a
// valid override without weakening what a caller of the base type could
// rely on.
import { and, DrizzleQueryError, eq, isNull, sql, type SQL } from 'drizzle-orm'
import postgres from 'postgres'
import type { MembershipRole } from '@/constants/tenant.constants'
import {
  tenantModel,
  tenantSettingsModel,
  type NewTenant,
  type Tenant,
} from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { HttpError } from '@/middlewares/error.middleware'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import { db } from '@/services/database.service'

// Postgres error code for a unique-constraint violation. Same source and
// same value as base.repository.ts's own — see that file's comment for the
// PostgreSQL docs reference.
const UNIQUE_VIOLATION_CODE = '23505'

/**
 * Whether an error thrown by `create`'s transaction is a Postgres
 * unique-constraint violation — i.e. `tenants_slug_unique`
 * (tenant.model.ts) already has a visible row for this slug. A deliberate
 * copy of `BaseRepository`'s identically-named private helper, not an
 * import: that method is module-private there by design (its own comment:
 * "the driver-level detail this file exists to keep out of every caller"),
 * and `create` here bypasses `BaseRepository.create`/
 * `translatingUniqueViolation` entirely (this file's header comment) —
 * same reasoning `auth-provider.repository.ts` and `register()`
 * (auth.controller.ts) already give for their own copies of this exact
 * check.
 * @param error - The error thrown by the transaction.
 * @returns True when the error is (or wraps) a 23505 unique violation.
 */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  return cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION_CODE
}

/**
 * The columns `TenantRepository.create` accepts for the tenant row itself,
 * plus `ownerId` — the user whose `'owner'` membership row is inserted
 * alongside it. Deliberately narrower than `NewTenant`: `id`, `deletedAt`,
 * `createdAt`, `updatedAt` and `lifecycleState` are never meant to be set
 * by hand on creation (a new tenant is always `active`, with
 * database-generated id/timestamps) — the same reasoning
 * `BaseRepository.update`'s own `Omit<..., 'id' | 'createdAt' |
 * 'updatedAt'>` already applies to every other mutation in this codebase.
 */
export type CreateTenantInput = Pick<NewTenant, 'name' | 'slug'> &
  Partial<Pick<NewTenant, 'description' | 'logo' | 'website'>> & {
    /**
     * The user who is creating this tenant. Becomes the tenant's sole
     * `'owner'` member — see this file's header comment for why this row
     * is written in the same transaction as the tenant itself.
     */
    ownerId: string
  }

/**
 * Query access to the `tenants` table: lookup by slug and/or id, atomic
 * creation (tenant + settings + owner membership), and the tenants a given
 * user belongs to. Every lookup excludes a soft-deleted tenant by default —
 * see `BaseRepository.scope`, which every lookup below is built on so none
 * can drift from `findById`'s soft-delete behaviour.
 */
export class TenantRepository extends BaseRepository<(typeof tenantModel)['_']['config']> {
  /**
   * Build a repository bound to the `tenants` table.
   */
  constructor() {
    super(tenantModel)
  }

  /**
   * Find a tenant by its slug.
   * @param slug - The slug to search for.
   * @param options - Soft-delete visibility options.
   * @returns The matching tenant, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findBySlug(slug: string, options: SoftDeleteOptions = {}): Promise<Tenant | undefined> {
    return this.selectOne(this.scope(eq(tenantModel.slug, slug), options))
  }

  /**
   * Find a tenant by either its slug or its id — a single lookup for a
   * caller that may have been handed either form (a route param that could
   * be a human-chosen slug or a raw id).
   * @param slugOrId - The slug or id to search for.
   * @param options - Soft-delete visibility options.
   * @returns The matching tenant, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findBySlugOrId(slugOrId: string, options: SoftDeleteOptions = {}): Promise<Tenant | undefined> {
    // Built with `sql` directly, not the `or()` helper: `or()`'s return
    // type is `SQL | undefined` (it can receive zero conditions, even
    // though this call site always passes two), which `scope`'s
    // `condition: SQL` parameter does not accept — same reasoning
    // `UserRepository.findByEmail` (user.repository.ts) already gives for
    // building its own condition this way. The parentheses are explicit
    // and load-bearing: `scope` combines this with `and(..., isNull(
    // deletedAt))`, and an un-parenthesized `slug = x or id = x` there
    // would bind as `slug = x or (id = x and deleted_at is null)` —
    // SQL's `and` binds tighter than `or` — silently letting a
    // soft-deleted row match by slug alone.
    return this.selectOne(
      this.scope(
        sql`(${tenantModel.slug} = ${slugOrId} or ${tenantModel.id} = ${slugOrId})`,
        options
      )
    )
  }

  /**
   * Find a tenant by slug, but only when it is fully usable: not
   * soft-deleted AND `lifecycleState === 'active'`. This is the lookup
   * `resolveTenant` (a later task's middleware) uses to decide whether a
   * tenant-scoped route even has a tenant to attach — a `suspended` tenant
   * must 404 here exactly like a nonexistent one, even though its row (and
   * `findBySlug`'s view of it) is otherwise perfectly intact. Unlike
   * `findBySlug`/`findBySlugOrId`, this method takes no `SoftDeleteOptions`
   * — "active" is not something a caller should ever be able to opt out
   * of; a caller that needs a suspended/archived tenant's row wants
   * `findBySlug(slug, { includeDeleted: true })` or a plain `findBySlug`,
   * not this method with a bypass flag bolted on.
   * @param slug - The slug to search for.
   * @returns The matching tenant, or undefined when no tenant with this slug is both visible and active.
   */
  findActiveBySlug(slug: string): Promise<Tenant | undefined> {
    // `sql` directly, not `and()` — see `findBySlugOrId`'s own comment for
    // why `and()`'s `SQL | undefined` return type does not satisfy
    // `scope`'s `condition: SQL` parameter. Plain `and` associativity means
    // no extra parentheses are needed for correctness here (unlike
    // `findBySlugOrId`'s `or`), but this file still combines every
    // multi-condition lookup through `sql` for one consistent shape.
    return this.selectOne(
      this.scope(sql`${tenantModel.slug} = ${slug} and ${tenantModel.lifecycleState} = 'active'`)
    )
  }

  /**
   * Every tenant one user belongs to, with the role they hold in each —
   * the query `GET /tenants` (a later task's controller) runs to list "my
   * organizations". A soft-deleted tenant is never included, even if the
   * user's membership row itself still exists (nothing prunes a membership
   * when its tenant is archived) — the same soft-delete visibility every
   * other lookup on this table gives.
   * @param userId - The user whose tenant memberships to list.
   * @returns One entry per tenant this user is (still visibly) a member of, in no particular guaranteed order.
   */
  async listForUser(userId: string): Promise<Array<{ tenant: Tenant; role: MembershipRole }>> {
    return db
      .select({ tenant: tenantModel, role: userMembershipModel.role })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(userMembershipModel.tenantId, tenantModel.id))
      .where(and(eq(userMembershipModel.userId, userId), isNull(tenantModel.deletedAt)))
  }

  /**
   * Create a tenant, its settings row, and its creator's `'owner'`
   * membership, all in one transaction — see this file's header comment
   * for why the three inserts are written directly against the
   * transaction's `tx` handle instead of calling
   * `TenantSettingsRepository`/`UserMembershipRepository`. A failure at any
   * point (most commonly, `input.slug` colliding with
   * `tenants_slug_unique`) rolls back all three; nothing this method
   * returns can exist without its settings row and owner membership also
   * existing.
   * @param input - The tenant's initial columns, plus `ownerId` — the user whose owner membership is created alongside it.
   * @returns The newly created tenant row (not the settings or membership rows — fetch those separately via `TenantSettingsRepository.findByTenantId`/`UserMembershipRepository.findByUserAndTenant` if needed).
   */
  async create(input: CreateTenantInput): Promise<Tenant> {
    try {
      return await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenantModel)
          .values({
            name: input.name,
            slug: input.slug,
            description: input.description,
            logo: input.logo,
            website: input.website,
          })
          .returning()

        // Same "cannot happen but guard anyway" reasoning as
        // UserRepository.insertOne (user.repository.ts): a single-row
        // insert.returning() that does not throw always returns exactly
        // one row.
        if (!tenant) throw new HttpError('Insert returned no row', 500)

        await tx.insert(tenantSettingsModel).values({ tenantId: tenant.id })

        await tx.insert(userMembershipModel).values({
          userId: input.ownerId,
          tenantId: tenant.id,
          role: 'owner',
        })

        return tenant
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('A tenant with this slug already exists', 409)
      }
      throw error
    }
  }

  /**
   * Select the single tenant matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @returns The matching tenant, or undefined when none exists.
   */
  protected async selectOne(where: SQL | undefined): Promise<Tenant | undefined> {
    const [row] = await db.select().from(tenantModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single tenant. Only reachable through the inherited
   * `BaseRepository.create` — this class's own `create` (above) bypasses
   * it entirely — but still required: `insertOne` is `abstract` on
   * `BaseRepository`, so a concrete subclass must implement it regardless
   * of whether anything calls it today.
   * @param values - The row's initial column values.
   * @returns The inserted tenant.
   */
  protected async insertOne(values: NewTenant): Promise<Tenant> {
    const [row] = await db.insert(tenantModel).values(values).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Update the single tenant matching a condition.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @returns The updated tenant, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<NewTenant, 'id' | 'createdAt' | 'updatedAt'>>>
  ): Promise<Tenant | undefined> {
    const [row] = await db.update(tenantModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single tenant matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @returns The updated tenant, or undefined when no matching row exists.
   */
  protected async markDeleted(where: SQL | undefined): Promise<Tenant | undefined> {
    const [row] = await db
      .update(tenantModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }
}
