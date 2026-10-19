/**
 * @file Signing in for tests the way a person does: by an emailed link.
 * `issueTestLink` mints the link's raw token directly, with no mail, and
 * `signInByLink` presents it to `POST /api/v1/auth/link/verify`, so a test
 * gets a real session (a refresh row, its cookie and an access token).
 */
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import { issueLinkToken } from '@/services/link-token.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { testRefreshCookie } from './refresh-cookie'
import { request } from './request'

/**
 * The app `signInByLink` posts to, built on first use so a file that only
 * calls `issueTestLink` never builds one.
 */
const built: { app?: ReturnType<typeof createApp> } = {}

/**
 * Mint a sign-in link for an address, as `POST /auth/link/request` would
 * mail it, valid for `SIGN_IN_LINK_TTL`.
 * @param email - The address the link is for.
 * @param app - The frontend it opens; `web` by default.
 * @param redirect - A stored redirect path, if any.
 * @returns The raw token.
 */
export async function issueTestLink(
  email: string,
  app: FrontendApp = 'web',
  redirect?: string
): Promise<string> {
  const { raw } = await issueLinkToken(
    { intent: 'sign_in', email, app, ...(redirect !== undefined && { redirect }) },
    requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  )
  return raw
}

/**
 * Sign in by a fresh link: the account is created on this click when the
 * address has none.
 * @param email - The address to sign in as.
 * @param app - The frontend the link opens; `web` by default.
 * @returns The access token, the refresh cookie as `name=value` for a `Cookie` header, and the user's id.
 * @throws {Error} When the verify does not answer 200 with a refresh cookie.
 */
export async function signInByLink(
  email: string,
  app: FrontendApp = 'web'
): Promise<{ accessToken: string; refreshCookie: string; userId: string }> {
  const token = await issueTestLink(email, app)
  built.app ??= createApp()
  const response = await request(built.app).post('/api/v1/auth/link/verify').send({ token })
  if (response.status !== 200) {
    throw new Error(`signInByLink: verify answered ${response.status}`)
  }
  const { name } = testRefreshCookie()
  const cookieLines = response.headers['set-cookie'] as unknown as string[] | undefined
  const refreshCookie = cookieLines
    ?.map((line) => line.split(';', 1)[0] ?? '')
    .findLast((pair) => pair.startsWith(`${name}=`))
  if (refreshCookie === undefined) throw new Error('signInByLink: no refresh cookie was set')
  const body = response.body as { data: { accessToken: string; user: { id: string } } }
  return { accessToken: body.data.accessToken, refreshCookie, userId: body.data.user.id }
}

/**
 * Delete every key of one rate limiter under this worker's prefix, so an
 * IP-keyed budget a file spends (`signInByLink` spends the link verify's)
 * does not carry from one test to the next.
 * @param name - The limiter's name, its `RATE_LIMITS` entry's `name`.
 */
export async function clearRateLimiter(name: string): Promise<void> {
  const client = await getRedis()
  const keys: string[] = []
  const batches = client.scanIterator({ MATCH: `${redisKey('rl', name)}:*` })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await client.del(keys)
}
