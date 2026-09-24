// src/repositories/notification-preference.repository.ts
//
// Deliberately does NOT extend BaseRepository — see
// notification.repository.ts's own header comment for the reasoning,
// which applies identically here: no soft-delete concept, no
// `deletedAt`/`updatedAt` columns, and nothing to translate a 23505 into
// (this table's only uniqueness guarantee is its composite primary key,
// and `upsert` below targets that key directly via `onConflictDoUpdate`
// rather than ever attempting a plain insert that could violate it).
//
// OPT-OUT, NOT OPT-IN. `notification_preferences` only ever stores an
// explicit CHOICE a user made — usually a channel they turned OFF. A user
// who has never visited their notification settings has no row here at
// all, and every method below treats "no row" as "every channel enabled"
// (see `isChannelEnabled` and `getFullMatrix`'s own comments) — never as
// "every channel disabled until the user opts in". Getting this default
// backwards would silently stop delivering a notification type a user
// never asked to be excluded from.
import { and, eq } from 'drizzle-orm'
import { NOTIFICATION_TYPES, type NotificationType } from '@/constants/notification.constants'
import {
  notificationPreferenceModel,
  type NotificationPreference,
} from '@/database/models/notification.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db } from '@/services/database.service'

/**
 * Which channel a notification can be delivered on. Matches
 * `notificationPreferenceModel`'s two boolean columns — `'email'` reads/
 * writes `emailEnabled`, `'in_app'` reads/writes `inAppEnabled`.
 */
export type NotificationChannel = 'email' | 'in_app'

/**
 * One notification type's resolved channel preferences, with defaults
 * already filled in for a type that has no row — the shape
 * `NotificationPreferenceRepository.getFullMatrix` returns one of, per
 * type.
 */
export interface NotificationPreferenceMatrixEntry {
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
 * `NotificationPreferenceRepository.getFullMatrix`'s return shape: every
 * known notification type, exactly once, with its resolved channel
 * preferences — never just the subset a user happens to have an explicit
 * row for.
 */
export type PreferenceMatrix = NotificationPreferenceMatrixEntry[]

// Notification types whose email channel a user may never disable — for TWO
// distinct reasons, not one stretched to cover both (plus a third, listing-only
// entry, 3. below):
//
//   1. LOCKOUT. `'verify_email'`: a user who could turn off email for their
//      OWN verification message would lock themselves out of ever verifying
//      their account, with no other channel able to reach them (in-app
//      notifications are only visible to a user who is already logged in,
//      which an unverified account may not even be able to do, depending on
//      how a later task gates login). `'password_reset_requested'` is the
//      identical lockout, one step earlier: the whole point of
//      forgot-password is that the user CANNOT log in, so a disabled email
//      channel would leave them with no channel at all — worse than
//      verify_email's case, since in-app is unreachable by definition here,
//      not merely by timing.
//   2. TAKEOVER SILENCING. `'password_changed'` locks nobody out — the
//      caller who changed the password is, by definition, currently able to
//      log in with it. The reason it belongs here anyway: if an attacker who
//      has already taken over the account could disable this one email, they
//      could change the password AND silence the one message that would
//      tell the real owner it happened, buying themselves unlimited time
//      before anyone notices. Non-disableable is what keeps that message
//      reaching the owner regardless of what the attacker's own preference
//      writes say.
//   3. KEPT IN STEP WITH THE WRITE SIDE. `'tenant_invitation'` has no email
//      on this path at all (the invitation mail goes straight to
//      addEmailJob); it is listed so this set still matches
//      NON_DISABLEABLE_NOTIFICATION_TYPES, where it is non-configurable.
//
// `ReadonlySet<string>`, not `ReadonlySet<NotificationType>`: `type` below
// is already narrowed to `NotificationType` by `isChannelEnabled`'s own
// parameter, so the wider element type costs nothing and avoids this set
// needing to be updated every time `NOTIFICATION_TYPES` gains an entry that
// ISN'T meant to join it.
//
// Kept in sync BY HAND with `NON_DISABLEABLE_NOTIFICATION_TYPES`
// (notification.validators.ts) — that set is the WRITE-side mirror of this
// one (its own comment explains why it cannot simply import this one), and
// letting the two disagree would let a client `PUT` a preference row this
// repository then silently ignores.
const NON_DISABLEABLE_EMAIL_TYPES: ReadonlySet<string> = new Set<string>([
  'verify_email',
  'password_reset_requested',
  'password_changed',
  'tenant_invitation',
])

/**
 * Query access to the `notification_preferences` table: read a user's
 * explicit preference rows, upsert one, resolve whether a specific
 * channel is currently enabled for a type (accounting for the opt-out
 * default and the non-disableable email exception), and resolve the full
 * per-type matrix a settings UI would render.
 */
export class NotificationPreferenceRepository {
  /**
   * Every explicit preference row a user has — NOT the full matrix. A user
   * who has never touched their settings has zero rows here even though
   * every channel is, in effect, enabled for them; use `getFullMatrix` for
   * "every type, with defaults filled in".
   * @param userId - The user whose preference rows to fetch.
   * @returns Every row this user has explicitly set, in no particular guaranteed order.
   */
  async findByUser(userId: string): Promise<NotificationPreference[]> {
    return db
      .select()
      .from(notificationPreferenceModel)
      .where(eq(notificationPreferenceModel.userId, userId))
  }

  /**
   * Create or replace one user's preference row for one notification type.
   * Targets the table's own composite primary key
   * (`userId`, `notificationType`) via `onConflictDoUpdate`, so this is
   * always exactly one row per pair — never a duplicate, and never a
   * 23505 a caller would need to catch.
   * @param userId - The user this preference belongs to.
   * @param notificationType - The notification type this preference governs.
   * @param data - The two channel toggles to set.
   * @param data.emailEnabled - Whether the email channel should be enabled for this type.
   * @param data.inAppEnabled - Whether the in-app channel should be enabled for this type.
   * @returns The resulting row, whether newly inserted or updated in place.
   */
  async upsert(
    userId: string,
    notificationType: NotificationType,
    data: { emailEnabled: boolean; inAppEnabled: boolean }
  ): Promise<NotificationPreference> {
    const [row] = await db
      .insert(notificationPreferenceModel)
      .values({ userId, notificationType, ...data })
      .onConflictDoUpdate({
        target: [notificationPreferenceModel.userId, notificationPreferenceModel.notificationType],
        set: data,
      })
      .returning()
    // db.insert(...).values(one object).returning() always returns exactly
    // one row when the write does not throw, upsert included — same
    // reasoning as NotificationRepository.create.
    if (row === undefined) throw new HttpError('Upsert returned no row', 500)
    return row
  }

  /**
   * Whether one channel is currently enabled for one user and notification
   * type — the single check a notification worker (a later task) makes
   * before delivering on that channel.
   *
   * A type's email channel is a fixed exception whenever it is in
   * `NON_DISABLEABLE_EMAIL_TYPES` — today `'verify_email'`,
   * `'password_reset_requested'`, `'password_changed'` and
   * `'tenant_invitation'`: it always answers true, regardless of any row a
   * user may have — see that set's own comment for why each entry is there.
   * Checked BEFORE the table is even queried, so this exception holds even
   * if a row exists with `emailEnabled: false` for it (which nothing in
   * this codebase's write path should produce, but this method does not
   * trust that from the read side).
   *
   * Absent that exception, "no row" means "enabled" — the opt-out default
   * this file's header comment describes.
   * @param userId - The user to check.
   * @param type - The notification type to check.
   * @param channel - Which channel to check.
   * @returns Whether this user currently receives this notification type on this channel.
   */
  async isChannelEnabled(
    userId: string,
    type: NotificationType,
    channel: NotificationChannel
  ): Promise<boolean> {
    if (channel === 'email' && NON_DISABLEABLE_EMAIL_TYPES.has(type)) return true

    const [row] = await db
      .select()
      .from(notificationPreferenceModel)
      .where(
        and(
          eq(notificationPreferenceModel.userId, userId),
          eq(notificationPreferenceModel.notificationType, type)
        )
      )

    if (!row) return true // opt-out default: no row = every channel enabled
    return channel === 'email' ? row.emailEnabled : row.inAppEnabled
  }

  /**
   * Every notification type's resolved channel preferences for one user —
   * `NOTIFICATION_TYPES.length` entries, always, whether or not this user
   * has ever set a preference for any of them. A settings UI (a later
   * task) renders this directly: it never needs to know which entries came
   * from a real row versus a default, because both are already resolved
   * into the same shape.
   * @param userId - The user to resolve the matrix for.
   * @returns One entry per known notification type, each with `emailEnabled`/`inAppEnabled` resolved from this user's row when one exists, or `true`/`true` (the opt-out default) when it does not.
   */
  async getFullMatrix(userId: string): Promise<PreferenceMatrix> {
    const rows = await this.findByUser(userId)
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
