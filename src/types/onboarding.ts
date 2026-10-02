/**
 * @file The customer's view of a tenant's onboarding, as
 * `GET /tenants/:slug/onboarding` sends it.
 */
import type {
  OnboardingScope,
  OnboardingSource,
  OnboardingState,
} from '@/constants/onboarding.constants'

/**
 * The states a customer sees. `stuck` and `awaiting_owner` are staff
 * concepts: a stuck tenant is reported as `in_progress`, and one awaiting
 * its first owner as `not_tracked`, since its clock has not started.
 */
export type CustomerOnboardingState = Extract<
  OnboardingState,
  'in_progress' | 'complete' | 'dismissed' | 'not_tracked'
>

/**
 * One registry step, with its completion as the viewer sees it.
 */
export interface TenantOnboardingStepView {
  key: string
  title: string
  description: string
  scope: OnboardingScope
  kind: 'auto' | 'manual'
  /**
   * Whether the tenant counts as complete only once this step is done.
   */
  required: boolean
  /**
   * ISO time of the completion: the tenant's for a tenant step, the viewer's
   * own for a member step (always null for a viewer with no membership).
   */
  completedAt: string | null
  source: OnboardingSource | null
}

/**
 * `GET /tenants/:slug/onboarding`.
 */
export interface TenantOnboardingView {
  state: CustomerOnboardingState
  steps: TenantOnboardingStepView[]
  requiredDone: number
  requiredTotal: number
  /**
   * ISO time the last required step completed; null until complete.
   */
  completedAt: string | null
  dismissedAt: string | null
}
