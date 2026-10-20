/**
 * @file Every 404 this API answers, as a stable `code` a frontend maps to its
 * own copy and a message that follows the copy rules: what happened, then
 * what to do. `tests/unit/errors/not-found-codes.test.ts` fails on a 404
 * thrown without a code.
 */
import { HttpError } from '@/errors/http-error'

/**
 * One kind of 404: its code and its message.
 */
interface NotFoundAnswer {
  code: string
  message: string
}

/**
 * The 404 answers, by what was not found. Two answers that must not be told
 * apart share one entry: `route` is the unknown-route 404 and also every
 * refusal that must look like one (a staff route to a non-staff caller, a
 * closed flag gate, a disabled webhook provider); `tenant` answers a
 * workspace that does not exist and one the caller cannot see alike.
 */
export const NOT_FOUND = {
  route: {
    code: 'not_found',
    message: 'No route matches this method and path. Check both, then try again.',
  },
  tenant: {
    code: 'tenant_not_found',
    message:
      "We couldn't find this workspace, or you're not a member of it. Check the link, or pick a workspace from your list.",
  },
  platformTenant: {
    code: 'tenant_not_found',
    message:
      "We couldn't find this tenant. It may have been purged. Go back to Tenants and search again.",
  },
  tenantSettings: {
    code: 'tenant_settings_not_found',
    message:
      "We couldn't load this workspace's settings. Refresh the page. If it happens again, contact support.",
  },
  member: {
    code: 'member_not_found',
    message: "This person is no longer a member. Refresh the member list to see who's on the team.",
  },
  user: {
    code: 'user_not_found',
    message:
      "We couldn't find this user. They may have been purged. Go back to Users and search again.",
  },
  ownAccount: {
    code: 'user_not_found',
    message: "We couldn't find your account. It may have been deleted. Sign in again to continue.",
  },
  notification: {
    code: 'notification_not_found',
    message:
      'This notification no longer exists. Refresh your notifications to see the current list.',
  },
  email: {
    code: 'email_not_found',
    message:
      "We couldn't find this email. It may have been purged. Go back to Emails and search again.",
  },
  suppression: {
    code: 'suppression_not_found',
    message:
      "We couldn't find this suppression. It may have been lifted already. Refresh the suppression list.",
  },
} as const satisfies Record<string, NotFoundAnswer>

/**
 * A key of NOT_FOUND.
 */
export type NotFoundKind = keyof typeof NOT_FOUND

/**
 * The 404 for one kind of thing not found.
 * @param kind - What was not found.
 * @returns The error to throw or pass to `next`.
 */
export function notFoundError(kind: NotFoundKind): HttpError {
  const { message, code } = NOT_FOUND[kind]
  return new HttpError(message, 404, code)
}
