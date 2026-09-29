/**
 * @file Query access to `tenants`. `create` overrides `BaseRepository.create`: it
 * takes `CreateTenantInput` (`NewTenant`'s columns plus `ownerId`) and writes the
 * tenant, its settings row and its owner membership in one transaction;
 * `createWithoutOwner` writes the first two, for staff.
 */
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import {
  SLUG_TAKEN_CODE,
  type MembershipRole,
  type TenantLifecycleState,
} from '@/constants/tenant.constants'
import {
  tenantModel,
  tenantSettingsModel,
  type NewTenant,
  type Tenant,
} from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import {
  db,
  withTransaction,
  type DbExecutor,
  type DbTransaction,
} from '@/services/database.service'

/**
 * The columns `TenantRepository.create` accepts for the tenant row itself,
 * plus `ownerId`, the user whose `'owner'` membership row is inserted
 * alongside it. `id`, `deletedAt`, `createdAt`, `updatedAt` and
 * `lifecycleState` are left to their database defaults.
 */
export type CreateTenantInput = Pick<NewTenant, 'name' | 'slug'> &
  Partial<Pick<NewTenant, 'description' | 'logo' | 'website'>> & {
    /**
     * The user creating this tenant, who becomes its sole `'owner'` member.
     */
    ownerId: string
  }

/**
 * Query access to the `tenants` table: lookup by slug and/or id, atomic
 * creation (tenant + settings + owner membership), and the tenants a given
 * user belongs to. Every lookup excludes a soft-deleted tenant by default.
 */
export class TenantRepository extends BaseRepository<(typeof tenantModel)['_']['config']> {
  /**
   * Build a repository bound to the `tenants` table.
   */
  constructor() {
    super(tenantModel)
  }

  /**
   * Insert the tenant row and its settings row in `tx`.
   * @param input - The tenant's initial columns.
   * @param tx - The transaction.
   * @returns The new tenant.
   */
  private async insertTenantAndSettings(
    input: Omit<CreateTenantInput, 'ownerId'>,
    tx: DbTransaction
  ): Promise<Tenant> {
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
    if (!tenant) throw new HttpError('Insert returned no row', 500)
    await tx.insert(tenantSettingsModel).values({ tenantId: tenant.id })
    return tenant
  }

  /**
   * Run a tenant insert, mapping a slug collision to 409.
   * @param write - The insert.
   * @returns The new tenant.
   * @throws {HttpError} 409 `slug_taken`, when the slug is taken by a live tenant.
   */
  private async withSlugConflict(write: () => Promise<Tenant>): Promise<Tenant> {
    try {
      return await write()
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('A tenant with this slug already exists', 409, SLUG_TAKEN_CODE)
      }
      throw error
    }
  }

  /**
   * Find a tenant by its slug.
   * @param slug - The slug to search for.
   * @param options - Soft-delete visibility options.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching tenant, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findBySlug(
    slug: string,
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<Tenant | undefined> {
    return this.selectOne(this.scope(eq(tenantModel.slug, slug), options), executor)
  }

  /**
   * Find a tenant by id whether or not it is soft-deleted.
   * @param id - The tenant id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The tenant, or undefined when no row has this id.
   */
  findByIdIncludingDeleted(id: string, executor: DbExecutor = db): Promise<Tenant | undefined> {
    return this.findById(id, { includeDeleted: true }, executor)
  }

  /**
   * Move a customer tenant from one of `from` to `to` in one conditional
   * UPDATE, so two racing transitions cannot both succeed. `archived` also
   * soft-deletes the row, which frees its slug. The platform tenant never
   * matches (and `tenants_platform_active` refuses it anyway).
   * @param id - The tenant id.
   * @param from - The states the tenant may be in now.
   * @param to - The new state.
   * @param tx - The transaction.
   * @returns The updated tenant, or undefined when no customer tenant with this id is in `from`.
   */
  async transitionLifecycle(
    id: string,
    from: readonly TenantLifecycleState[],
    to: TenantLifecycleState,
    tx: DbTransaction
  ): Promise<Tenant | undefined> {
    const [row] = await tx
      .update(tenantModel)
      .set({
        lifecycleState: to,
        updatedAt: sql`now()`,
        ...(to === 'archived' && { deletedAt: sql`now()` }),
      })
      .where(
        and(
          eq(tenantModel.id, id),
          eq(tenantModel.isPlatform, false),
          isNull(tenantModel.deletedAt),
          inArray(tenantModel.lifecycleState, [...from])
        )
      )
      .returning()
    return row
  }

  /**
   * Find a tenant by slug, but only when it is fully usable: not
   * soft-deleted and `lifecycleState === 'active'`. `resolveTenant`
   * (tenant.middleware.ts) uses it, so a suspended tenant answers 404 like a
   * missing one. It takes no `SoftDeleteOptions`: a caller that needs a
   * suspended or archived tenant uses `findBySlug`.
   * @param slug - The slug to search for.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching tenant, or undefined when no tenant with this slug is both visible and active.
   */
  findActiveBySlug(slug: string, executor: DbExecutor = db): Promise<Tenant | undefined> {
    return this.selectOne(
      this.scope(sql`${tenantModel.slug} = ${slug} and ${tenantModel.lifecycleState} = 'active'`),
      executor
    )
  }

  /**
   * Find a live tenant by id and lock its row (`SELECT … FOR NO KEY UPDATE`)
   * for the rest of the transaction. No transaction that takes it deletes a
   * tenant or changes its id, so foreign-key inserts referencing the tenant
   * (audit rows, memberships, invitations) do not wait for it. Lock order:
   * after the access locks `lockTenantAccess` takes (tenant-access.service.ts).
   * @param id - The tenant's id.
   * @param executor - The transaction to hold the lock in. Required: on the pool, the lock would release as soon as the statement finished.
   * @returns The locked tenant, or undefined when none exists or it is soft-deleted.
   */
  async lockById(id: string, executor: DbTransaction): Promise<Tenant | undefined> {
    const [row] = await executor
      .select()
      .from(tenantModel)
      .where(this.scope(eq(tenantModel.id, id)))
      .limit(1)
      .for('no key update')
    return row
  }

  /**
   * The seeded platform tenant, the one row with `isPlatform` set.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The platform tenant, or undefined only on a database migration 0016 has not reached.
   */
  findPlatformTenant(executor: DbExecutor = db): Promise<Tenant | undefined> {
    return this.selectOne(this.scope(eq(tenantModel.isPlatform, true)), executor)
  }

  /**
   * Every tenant one user belongs to, with the role they hold in each, for
   * `GET /tenants`. A soft-deleted tenant is excluded even though the user's
   * membership row still exists: nothing prunes it when the tenant is deleted.
   * @param userId - The user whose tenant memberships to list.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per tenant this user is (still visibly) a member of, in no particular guaranteed order.
   */
  async listForUser(
    userId: string,
    executor: DbExecutor = db
  ): Promise<Array<{ tenant: Tenant; role: MembershipRole }>> {
    return executor
      .select({ tenant: tenantModel, role: userMembershipModel.role })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(userMembershipModel.tenantId, tenantModel.id))
      .where(and(eq(userMembershipModel.userId, userId), isNull(tenantModel.deletedAt)))
  }

  /**
   * Create a tenant, its settings row, and its creator's `'owner'`
   * membership, all in one transaction. A failure at any point (most often a
   * slug colliding with `tenants_slug_unique`) rolls back all three. A passed-in
   * transaction is reused (`withTransaction`), so a caller's own transaction
   * stays one atomic unit.
   * @param input - The tenant's initial columns, plus `ownerId` — the user whose owner membership is created alongside it.
   * @param executor - An existing transaction to compose into, or the pool (default) to open a new transaction in.
   * @returns The newly created tenant row (not the settings or membership rows — fetch those separately via `TenantSettingsRepository.findByTenantId`/`UserMembershipRepository.findByUserAndTenant` if needed).
   * @throws {HttpError} 409 `slug_taken`, when the slug is taken by a live tenant.
   */
  async create(input: CreateTenantInput, executor: DbExecutor = db): Promise<Tenant> {
    return this.withSlugConflict(() =>
      withTransaction(async (tx) => {
        const tenant = await this.insertTenantAndSettings(input, tx)
        await tx.insert(userMembershipModel).values({
          userId: input.ownerId,
          tenantId: tenant.id,
          role: 'owner',
        })
        return tenant
      }, executor)
    )
  }

  /**
   * Create a tenant and its settings row with no members, for staff creating
   * a tenant whose owner is then invited (platform-tenant.service.ts).
   * @param input - The tenant's initial columns.
   * @param executor - An existing transaction to compose into, or the pool (default).
   * @returns The new tenant.
   * @throws {HttpError} 409 `slug_taken`, when the slug is taken by a live tenant.
   */
  async createWithoutOwner(
    input: Omit<CreateTenantInput, 'ownerId'>,
    executor: DbExecutor = db
  ): Promise<Tenant> {
    return this.withSlugConflict(() =>
      withTransaction((tx) => this.insertTenantAndSettings(input, tx), executor)
    )
  }

  /**
   * Select the single tenant matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching tenant, or undefined when none exists.
   */
  protected async selectOne(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<Tenant | undefined> {
    const [row] = await executor.select().from(tenantModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single tenant. `BaseRepository` declares it abstract; this class's
   * own `create` does not call it.
   * @param values - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted tenant.
   */
  protected async insertOne(values: NewTenant, executor: DbExecutor = db): Promise<Tenant> {
    const [row] = await executor.insert(tenantModel).values(values).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Update the single tenant matching a condition.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated tenant, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<NewTenant, 'id' | 'createdAt' | 'updatedAt'>>>,
    executor: DbExecutor = db
  ): Promise<Tenant | undefined> {
    const [row] = await executor.update(tenantModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single tenant matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated tenant, or undefined when no matching row exists.
   */
  protected async markDeleted(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<Tenant | undefined> {
    const [row] = await executor
      .update(tenantModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }

  /**
   * Permanently delete an archived customer tenant. Settings, memberships
   * and invitations cascade; `audit_logs.tenant_id` is RESTRICT, so its
   * entries must go first.
   * @param id - The tenant.
   * @param tx - The purge's transaction.
   * @returns True when an archived customer tenant was deleted.
   */
  async purgeArchived(id: string, tx: DbTransaction): Promise<boolean> {
    const rows = await tx
      .delete(tenantModel)
      .where(
        and(
          eq(tenantModel.id, id),
          eq(tenantModel.isPlatform, false),
          eq(tenantModel.lifecycleState, 'archived'),
          isNotNull(tenantModel.deletedAt)
        )
      )
      .returning({ id: tenantModel.id })
    return rows.length > 0
  }
}
