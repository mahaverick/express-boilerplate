/**
 * @file The reads every flag consumer goes through: route gates, the read
 * and exposure endpoints, the staff inspector and service code (workers
 * too). Each evaluates against this process's snapshot and never throws:
 * every failure serves the registry fallback. Only `variantOf` on an
 * experiment records exposure; `flagsFor`, `isEnabled` and `evaluateAll`
 * never do.
 */
import { isFlagsEnabled } from '@/configs/analytics.config'
import {
  clientFlagsFor,
  flagEntry,
  FLAGS,
  type BooleanFlagKey,
  type FlagEntry,
  type FlagKey,
  type MultivariateFlagKey,
  type VariantOf,
} from '@/constants/flags.constants'
import { recordUnknownVariant } from '@/services/flags/flag-counters.service'
import { evaluateFlag } from '@/services/flags/flag-evaluator.service'
import { recordExposure } from '@/services/flags/flag-exposure.service'
import { getFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import type { ExposureOrigin, FlagApp, FlagContext, FlagEvaluation } from '@/types/flags'

/**
 * Evaluate one entry against this process's snapshot, counting an undeclared variant.
 * @param context - The evaluation context.
 * @param entry - The registry entry.
 * @returns The evaluation.
 */
async function evaluateEntry(context: FlagContext, entry: FlagEntry): Promise<FlagEvaluation> {
  return evaluateFlag(entry, getFlagSnapshot(), context, {
    isConfigured: isFlagsEnabled(),
    onUnknownVariant: (key) => {
      void recordUnknownVariant(key)
    },
  })
}

/**
 * Evaluate one registered flag, with its reason. Records no exposure.
 * @param context - The evaluation context.
 * @param key - The flag.
 * @returns The evaluation.
 */
export async function evaluateKey(context: FlagContext, key: FlagKey): Promise<FlagEvaluation> {
  return evaluateEntry(context, flagEntry(key))
}

/**
 * Evaluate every registered flag, with its reason, in registry order (the
 * staff evaluate view). Records no exposure.
 * @param context - The evaluation context.
 * @returns One evaluation per flag.
 */
export async function evaluateAll(
  context: FlagContext
): Promise<{ key: FlagKey; evaluation: FlagEvaluation }[]> {
  return Promise.all(
    FLAGS.map(async (entry) => ({
      key: entry.key,
      evaluation: await evaluateEntry(context, entry),
    }))
  )
}

/**
 * The values of every registered flag, or with `app` only the flags that
 * app receives (`client` and the app in `apps`). The app filters the list;
 * it is never a trait. Records no exposure.
 * @param context - The evaluation context.
 * @param options - Read options.
 * @param options.app - The app whose client flags to return; omitted, every flag.
 * @returns The values by key.
 */
export async function flagsFor(
  context: FlagContext,
  options: { app?: FlagApp } = {}
): Promise<Record<string, boolean | string>> {
  const entries = options.app === undefined ? FLAGS : clientFlagsFor(options.app)
  const pairs = await Promise.all(
    entries.map(async (entry) => {
      const evaluation = await evaluateEntry(context, entry)
      return [entry.key, evaluation.value] as const
    })
  )
  return Object.fromEntries(pairs)
}

/**
 * Whether a boolean flag is on. Records no exposure: experiments are multivariate only.
 * @param context - The evaluation context.
 * @param key - The flag.
 * @returns The value; its fallback, false, on any failure.
 */
export async function isEnabled(context: FlagContext, key: BooleanFlagKey): Promise<boolean> {
  const evaluation = await evaluateKey(context, key)
  return evaluation.value === true
}

/**
 * A multivariate flag's variant. For an experiment it also records the
 * exposure (`recordExposure`, which skips evaluations outside the
 * experiment), from the server unless told otherwise.
 * @param context - The evaluation context.
 * @param key - The flag.
 * @param options - Read options.
 * @param options.exposure - The origin to record an experiment's exposure
 *   under (`server` by default), or false to record none.
 * @returns The variant; its fallback, `variants[0]`, on any failure.
 */
export async function variantOf<K extends MultivariateFlagKey>(
  context: FlagContext,
  key: K,
  options: { exposure?: ExposureOrigin | false } = {}
): Promise<VariantOf<K>> {
  const entry = flagEntry(key)
  const evaluation = await evaluateEntry(context, entry)
  const origin = options.exposure ?? 'server'
  if (origin !== false && entry.experiment) await recordExposure(context, key, evaluation, origin)
  return evaluation.value as VariantOf<K>
}
