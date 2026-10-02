/**
 * @file Query access to the append-only `onboarding_completions` table. It
 * does not extend `BaseRepository`: a completion is never updated or
 * soft-deleted. `completeOnboardingStep` (onboarding.service.ts) is its only
 * writer.
 */
import { and, asc, eq } from 'drizzle-orm'
import {
  onboardingCompletionModel,
  type NewOnboardingCompletion,
  type OnboardingCompletion,
} from '@/database/models/onboarding-completion.model'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * Query access to `onboarding_completions`.
 */
export class OnboardingCompletionRepository {
  /**
   * Record one completion unless the step is already complete for that
   * tenant (tenant step) or member (member step):
   * `onboarding_completions_step_unique` makes a repeat a no-op. No conflict
   * target is named, because that index is on an expression.
   * @param row - The completion.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, or undefined when the step was already complete.
   */
  async insertIfNew(
    row: NewOnboardingCompletion,
    executor: DbExecutor = db
  ): Promise<OnboardingCompletion | undefined> {
    const [inserted] = await executor
      .insert(onboardingCompletionModel)
      .values(row)
      .onConflictDoNothing()
      .returning()
    return inserted
  }

  /**
   * Every completion recorded in a tenant, tenant and member steps alike,
   * whether or not its step is still in the registry.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows, oldest first.
   */
  async listForTenant(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<OnboardingCompletion[]> {
    return executor
      .select()
      .from(onboardingCompletionModel)
      .where(eq(onboardingCompletionModel.tenantId, tenantId))
      .orderBy(asc(onboardingCompletionModel.completedAt), asc(onboardingCompletionModel.id))
  }

  /**
   * One member's own completions in a tenant.
   * @param tenantId - The tenant.
   * @param userId - The member.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows, oldest first.
   */
  async listForTenantAndUser(
    tenantId: string,
    userId: string,
    executor: DbExecutor = db
  ): Promise<OnboardingCompletion[]> {
    return executor
      .select()
      .from(onboardingCompletionModel)
      .where(
        and(
          eq(onboardingCompletionModel.tenantId, tenantId),
          eq(onboardingCompletionModel.userId, userId)
        )
      )
      .orderBy(asc(onboardingCompletionModel.completedAt), asc(onboardingCompletionModel.id))
  }
}
