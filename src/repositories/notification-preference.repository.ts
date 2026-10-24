/**
 * @file Query access to `notification_preferences`. Opt-out, not opt-in: a row
 * stores a choice the user made, and "no row" means every channel is enabled.
 * It does not extend `BaseRepository`: no `deletedAt`/`updatedAt`, and `upsert`
 * targets the composite primary key, so there is no 23505 to translate.
 */
import { and, eq } from 'drizzle-orm'
import { NOTIFICATION_TYPES, type NotificationType } from '@/constants/notification.constants'
import {
  notificationPreferenceModel,
  type NotificationPreference,
} from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * Which channel a notification can be delivered on: `'email'` is the
 * `emailEnabled` column of `notificationPreferenceModel`, `'in_app'` the
 * `inAppEnabled` column.
 */
export type NotificationChannel = 'email' | 'in_app'

/**
 * One notification type's channel preferences, with defaults filled in
 * for a type the user has no row for.
 */
interface NotificationPreferenceMatrixEntry {
  /**
   * The notification type this entry describes.
   */
  notificationType: NotificationType
  /**
   * Whether the email channel is enabled for this type.
   */
  emailEnabled: boolean
  /**
   * Whether the in-app channel is enabled for this type.
   */
  inAppEnabled: boolean
}

/**
 * What `NotificationPreferenceRepository.getFullMatrix` returns: every known
 * notification type exactly once, including types the user has no row for.
 */
export type PreferenceMatrix = NotificationPreferenceMatrixEntry[]

/**
 * Notification types whose email channel a user may never disable:
 * `tenant_invitation`, which sends no email on this path and is listed to
 * match the write side, `maintenance_mode_changed`, so no owner or admin
 * can miss that customers are locked out, and the billing notices, so no
 * owner misses that their workspace is about to lose Paid, needs a card, or
 * turns people away. Keep in sync by hand with
 * `NON_DISABLEABLE_NOTIFICATION_TYPES` (notification.validators.ts), or a
 * client could `PUT` a preference this repository then ignores.
 */
const NON_DISABLEABLE_EMAIL_TYPES: ReadonlySet<string> = new Set<string>([
  'tenant_invitation',
  'maintenance_mode_changed',
  'billing_trial_ending',
  'billing_payment_failed',
  'billing_upgrade_requested',
  'billing_payer_left',
  'workspace_full',
])

/**
 * Query access to `notification_preferences`: read a user's explicit rows,
 * upsert one, decide whether a channel is enabled for a type (applying the
 * opt-out default and the non-disableable email types), and resolve the
 * per-type matrix a settings UI renders.
 */
export class NotificationPreferenceRepository {
  /**
   * Every explicit preference row a user has, not the full matrix. A user
   * who has never changed a setting has no rows here although every channel
   * is enabled for them; use `getFullMatrix` for every type with defaults
   * filled in.
   * @param userId - The user whose preference rows to fetch.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Every row this user has explicitly set, in no particular guaranteed order.
   */
  async findByUser(userId: string, executor: DbExecutor = db): Promise<NotificationPreference[]> {
    return executor
      .select()
      .from(notificationPreferenceModel)
      .where(eq(notificationPreferenceModel.userId, userId))
  }

  /**
   * Create or replace one user's preference row for one notification type.
   * The upsert targets the composite primary key, so it never raises a 23505.
   * It refuses `emailEnabled: false` for a type in `NON_DISABLEABLE_EMAIL_TYPES`
   * (400, nothing written), so no caller can store a disabled email channel
   * the read side would ignore.
   * @param userId - The user this preference belongs to.
   * @param notificationType - The notification type this preference governs.
   * @param data - The two channel toggles to set.
   * @param data.emailEnabled - Whether the email channel should be enabled for this type.
   * @param data.inAppEnabled - Whether the in-app channel should be enabled for this type.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The resulting row, whether newly inserted or updated in place.
   * @throws {HttpError} 400 when `data.emailEnabled` is false for a non-disableable email type.
   */
  async upsert(
    userId: string,
    notificationType: NotificationType,
    data: { emailEnabled: boolean; inAppEnabled: boolean },
    executor: DbExecutor = db
  ): Promise<NotificationPreference> {
    if (!data.emailEnabled && NON_DISABLEABLE_EMAIL_TYPES.has(notificationType)) {
      throw new HttpError(
        "You can't turn off email for this notification type. You can turn off its in-app notifications.",
        400
      )
    }
    const [row] = await executor
      .insert(notificationPreferenceModel)
      .values({ userId, notificationType, ...data })
      .onConflictDoUpdate({
        target: [notificationPreferenceModel.userId, notificationPreferenceModel.notificationType],
        set: data,
      })
      .returning()
    if (row === undefined) throw new HttpError('Upsert returned no row', 500)
    return row
  }

  /**
   * Whether one channel is currently enabled for one user and notification
   * type: the check notification.worker.ts makes before delivering on it.
   *
   * The email channel of a type in `NON_DISABLEABLE_EMAIL_TYPES` is always
   * enabled, checked before the table is queried, so a row with
   * `emailEnabled: false` for it is ignored. Otherwise "no row" means enabled.
   * @param userId - The user to check.
   * @param type - The notification type to check.
   * @param channel - Which channel to check.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Whether this user currently receives this notification type on this channel.
   */
  async isChannelEnabled(
    userId: string,
    type: NotificationType,
    channel: NotificationChannel,
    executor: DbExecutor = db
  ): Promise<boolean> {
    if (channel === 'email' && NON_DISABLEABLE_EMAIL_TYPES.has(type)) return true

    const [row] = await executor
      .select()
      .from(notificationPreferenceModel)
      .where(
        and(
          eq(notificationPreferenceModel.userId, userId),
          eq(notificationPreferenceModel.notificationType, type)
        )
      )

    if (!row) return true
    return channel === 'email' ? row.emailEnabled : row.inAppEnabled
  }

  /**
   * Every notification type's resolved channel preferences for one user:
   * `NOTIFICATION_TYPES.length` entries, always, with defaults filled in for a
   * type the user has no row for.
   * @param userId - The user to resolve the matrix for.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per known notification type, each with `emailEnabled`/`inAppEnabled` resolved from this user's row when one exists, or `true`/`true` (the opt-out default) when it does not.
   */
  async getFullMatrix(userId: string, executor: DbExecutor = db): Promise<PreferenceMatrix> {
    const rows = await this.findByUser(userId, executor)
    const byType = new Map(rows.map((row) => [row.notificationType, row]))

    return NOTIFICATION_TYPES.map((type) => {
      const row = byType.get(type)
      return {
        notificationType: type,
        emailEnabled: row?.emailEnabled ?? true,
        inAppEnabled: row?.inAppEnabled ?? true,
      }
    })
  }
}
