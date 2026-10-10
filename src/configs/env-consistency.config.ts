/**
 * @file Cross-field environment rules, run once at boot by index.ts. They live
 * outside `EnvSchema` because an object-level `.refine()` would break
 * `getDatabaseUrl()`'s `.pick()`.
 */
import { isCookieSecure, isProxyTrustOff, type Env } from '@/configs/env.config'
import { SERVER_DRAIN_TIMEOUT_MS } from '@/constants/global.constants'
import { senderDomain, senderFor } from '@/utilities/email-sender.utilities'

/**
 * Time left after a hung send gives up, for the database, Redis, queue and
 * OTel closes that run after the workers close. The error-report flush
 * (`ERROR_SHUTDOWN_FLUSH_MS`, 3 s) runs there too, so with SMTP and PostHog
 * both hanging it takes 3 s of this.
 */
const SHUTDOWN_HEADROOM_MS = 5000

const LOCAL_SMTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const MAILPIT_SMTP_PORT = 1025
const PLACEHOLDER_MAIL_FROM = 'no-reply@example.com'

/**
 * SMTP settings that only make sense against the local Mailpit.
 * @param env - The validated environment, with APP_ENV other than local.
 * @returns One message per Mailpit default still in place.
 */
function mailpitDefaultProblems(env: Env): string[] {
  const problems: string[] = []
  if (LOCAL_SMTP_HOSTS.has(env.SMTP_HOST)) {
    problems.push(
      `SMTP_HOST is ${env.SMTP_HOST}, the local Mailpit default, but APP_ENV is ${env.APP_ENV}. Set SMTP_HOST to your mail provider.`
    )
  }
  if (env.SMTP_PORT === MAILPIT_SMTP_PORT) {
    problems.push(
      `SMTP_PORT is ${String(MAILPIT_SMTP_PORT)}, Mailpit's port, but APP_ENV is ${env.APP_ENV}. Set SMTP_PORT to your provider's submission port, usually 587.`
    )
  }
  if (env.MAIL_FROM === PLACEHOLDER_MAIL_FROM) {
    problems.push(
      `MAIL_FROM is ${PLACEHOLDER_MAIL_FROM}, the placeholder, but APP_ENV is ${env.APP_ENV}. Set MAIL_FROM to a sender your provider has verified.`
    )
  }
  if (env.MAIL_FROM_TRANSACTIONAL === PLACEHOLDER_MAIL_FROM) {
    problems.push(
      `MAIL_FROM_TRANSACTIONAL is ${PLACEHOLDER_MAIL_FROM}, the placeholder, but APP_ENV is ${env.APP_ENV}. Set MAIL_FROM_TRANSACTIONAL to a sender your provider has verified, or unset it to use MAIL_FROM.`
    )
  }
  return problems
}

/**
 * Warn when token emails go out from the general sender's domain. A
 * provider that tracks clicks on that domain rewrites every link through
 * itself, so it would see each verification, reset, setup and invitation
 * token. A warning, not a refusal: many providers track no clicks at all.
 * @param env - The validated environment, with APP_ENV other than local.
 * @param warn - Receives the warning, when both senders share a domain.
 */
function warnOnSharedSenderDomain(env: Env, warn: (message: string) => void): void {
  const domain = senderDomain(env.MAIL_FROM)
  if (senderDomain(senderFor('transactional', env)) !== domain) return
  const which =
    env.MAIL_FROM_TRANSACTIONAL === undefined
      ? 'MAIL_FROM_TRANSACTIONAL is unset, so token emails'
      : `MAIL_FROM_TRANSACTIONAL shares MAIL_FROM's domain, so token emails`
  warn(
    `${which} (verification, password reset, account setup, invitations) go out from ${domain}. If your provider tracks clicks on ${domain}, it rewrites their links and sees every token. Set MAIL_FROM_TRANSACTIONAL to an address on a domain with click tracking off; see "Email tracking" in ARCHITECTURE.md.`
  )
}

/**
 * Whether a browser would accept a cookie with this Domain attribute from a
 * response by this host.
 * @param domain - A `COOKIE_DOMAIN` value, with or without one leading dot.
 * @param host - The responding host name.
 * @returns True when the host equals the domain or is a subdomain of it, ignoring case.
 */
function isHostWithinCookieDomain(domain: string, host: string): boolean {
  // Browsers strip one leading dot (RFC 6265 §5.2.3).
  const bare = domain.replace(/^\./, '').toLowerCase()
  const lowerHost = host.toLowerCase()
  return lowerHost === bare || lowerHost.endsWith(`.${bare}`)
}

/**
 * A `COOKIE_DOMAIN` that `APP_URL`'s host is not within. Browsers reject a
 * Set-Cookie whose Domain does not domain-match the responding host, so every
 * auth cookie would be dropped in silence.
 * @param env - The validated environment.
 * @returns A message when the domain cannot apply to `APP_URL`, else undefined.
 */
function cookieDomainProblem(env: Env): string | undefined {
  if (env.COOKIE_DOMAIN === undefined) return undefined
  const host = new URL(env.APP_URL).hostname.toLowerCase()
  if (isHostWithinCookieDomain(env.COOKIE_DOMAIN, host)) return undefined
  return `COOKIE_DOMAIN is ${env.COOKIE_DOMAIN}, but APP_URL's host ${host} is not within it, so browsers reject every auth cookie. Set COOKIE_DOMAIN to ${host} or a parent domain of it, or unset it.`
}

/**
 * Google calls back to APP_URL only. A sign-in started on an Apex host that
 * differs from APP_URL's loses its OAuth session cookie on the way back, and
 * its refresh cookie lands on APP_URL's host, unless COOKIE_DOMAIN covers both.
 * @param env - The validated environment.
 * @returns A message when that combination is configured, else undefined.
 */
function apexCookieDomainProblem(env: Env): string | undefined {
  if (env.APEX_URL === undefined || env.GOOGLE_CLIENT_ID === undefined) return undefined
  const apexHost = new URL(env.APEX_URL).hostname.toLowerCase()
  const appHost = new URL(env.APP_URL).hostname.toLowerCase()
  if (apexHost === appHost) return undefined
  if (env.COOKIE_DOMAIN !== undefined && isHostWithinCookieDomain(env.COOKIE_DOMAIN, apexHost)) {
    return undefined
  }
  return `APEX_URL's host ${apexHost} differs from APP_URL's host ${appHost} and Google sign-in is on (GOOGLE_CLIENT_ID), so a sign-in started in Apex loses its session on the way back. Set COOKIE_DOMAIN to a parent domain of both hosts, or serve Apex from APP_URL's host.`
}

/**
 * Warn when analytics is on outside local and test but no proxy hop is
 * trusted. The analytics proxy forwards `request.ip` to PostHog as the
 * browser's address: with `TRUST_PROXY` false that is the frontend proxy's, so
 * PostHog's GeoIP is wrong and its cookieless hash merges different people.
 * @param env - The validated environment.
 * @param warn - Receives the warning.
 */
function warnOnUntrustedProxyForAnalytics(env: Env, warn: (message: string) => void): void {
  if (
    env.APP_ENV === 'local' ||
    env.POSTHOG_PROJECT_KEY === undefined ||
    !isProxyTrustOff(env.TRUST_PROXY)
  ) {
    return
  }
  warn(
    'POSTHOG_PROJECT_KEY is set and TRUST_PROXY is false. The analytics proxy sends every browser event to PostHog with the address of the proxy in front of this app, so GeoIP is wrong for everyone and, with cookieless hashing, different people merge. Set TRUST_PROXY to the number of proxies in front of this app, counting every hop (the frontend nginx and the load balancer).'
  )
}

/**
 * Warn when only half of the timeline credentials is set. The timelines and
 * PostHog person deletion need both, so with one alone they stay off and
 * nothing else says why.
 * @param env - The validated environment.
 * @param warn - Receives the warning, naming the missing variable.
 */
function warnOnHalfTimelineConfig(env: Env, warn: (message: string) => void): void {
  const hasKey = env.POSTHOG_PERSONAL_API_KEY !== undefined
  if (hasKey === (env.POSTHOG_PROJECT_ID !== undefined)) return
  const [presentName, missingName] = hasKey
    ? ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID']
    : ['POSTHOG_PROJECT_ID', 'POSTHOG_PERSONAL_API_KEY']
  warn(
    `${presentName} is set but ${missingName} is not, so the staff timelines answer "not configured" and PostHog person deletions wait. Set ${missingName} too, or unset ${presentName}.`
  )
}

/**
 * The feature flags key without the project key. The definitions fetch
 * sends `?token=<project key>`, so the flags key alone can never work.
 * @param env - The validated environment.
 * @returns One message when only the flags key is set, else none.
 */
function flagsKeyProblems(env: Env): string[] {
  if (env.POSTHOG_FEATURE_FLAGS_KEY === undefined || env.POSTHOG_PROJECT_KEY !== undefined) {
    return []
  }
  return [
    'POSTHOG_FEATURE_FLAGS_KEY is set but POSTHOG_PROJECT_KEY is not, so feature flag definitions cannot be fetched. Set POSTHOG_PROJECT_KEY too, or unset POSTHOG_FEATURE_FLAGS_KEY.',
  ]
}

/**
 * Refuses unsafe or inconsistent configuration at boot; throws Error with one actionable message.
 *
 * Every problem found goes into that one message, so an operator fixes them
 * all in one pass. Warnings go to `warn` and never stop boot. The SMTP
 * timeouts must fit in what SHUTDOWN_TIMEOUT_MS leaves after the HTTP drain
 * and the headroom, since `gracefulShutdown` drains HTTP before it waits for
 * the in-flight send; on local that is a warning.
 * @param env - The validated environment from `getEnv()`.
 * @param warn - Receives each warning message.
 * @throws {Error} Listing every problem, when there is at least one.
 */
export function assertEnvConsistent(env: Env, warn: (message: string) => void): void {
  const problems: string[] = []
  const isLocal = env.APP_ENV === 'local'

  if (!isLocal && env.NODE_ENV !== 'production') {
    problems.push(
      `NODE_ENV is ${env.NODE_ENV}, but APP_ENV is ${env.APP_ENV}. Set NODE_ENV=production: outside production, Express's built-in error handler sends stack traces.`
    )
  }
  if (!isLocal) {
    problems.push(...mailpitDefaultProblems(env))
    warnOnSharedSenderDomain(env, warn)
  }

  const domainProblem = cookieDomainProblem(env)
  if (domainProblem !== undefined) problems.push(domainProblem)
  const apexProblem = apexCookieDomainProblem(env)
  if (apexProblem !== undefined) problems.push(apexProblem)

  // Half a pair sends no auth, so every send to a provider that needs it fails silently.
  if ((env.SMTP_USERNAME === undefined) !== (env.SMTP_PASSWORD === undefined)) {
    const [presentName, missingName] =
      env.SMTP_USERNAME === undefined
        ? ['SMTP_PASSWORD', 'SMTP_USERNAME']
        : ['SMTP_USERNAME', 'SMTP_PASSWORD']
    problems.push(
      `Only ${presentName} is set. Set ${missingName} too, or neither (Mailpit needs neither).`
    )
  }

  // A sanity check, not a bound: the sum covers one address and no DNS time.
  const smtpChainMs =
    env.SMTP_CONNECTION_TIMEOUT_MS + env.SMTP_GREETING_TIMEOUT_MS + env.SMTP_SOCKET_TIMEOUT_MS
  const smtpBudgetMs = env.SHUTDOWN_TIMEOUT_MS - SERVER_DRAIN_TIMEOUT_MS - SHUTDOWN_HEADROOM_MS
  if (smtpChainMs > smtpBudgetMs) {
    const message = `SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS is ${String(smtpChainMs)} ms, more than the ${String(smtpBudgetMs)} ms that SHUTDOWN_TIMEOUT_MS (${String(env.SHUTDOWN_TIMEOUT_MS)} ms) leaves after the ${String(SERVER_DRAIN_TIMEOUT_MS)} ms HTTP drain and ${String(SHUTDOWN_HEADROOM_MS)} ms of headroom, so a send that hangs at each stage, even against a single address, outlasts graceful shutdown and the process exits 1 before closing its connections. Lower the SMTP timeouts, or raise SHUTDOWN_TIMEOUT_MS together with the orchestrator's termination grace period.`
    if (isLocal) warn(message)
    else problems.push(message)
  }

  // express-session sends a Secure cookie only when req.secure, which behind TLS needs TRUST_PROXY.
  if (
    isCookieSecure(env) &&
    env.GOOGLE_CLIENT_ID !== undefined &&
    isProxyTrustOff(env.TRUST_PROXY)
  ) {
    warn(
      'Auth cookies are Secure (COOKIE_SECURE, on by default outside local) and TRUST_PROXY is false. Behind a TLS-terminating proxy, express-session then sees plain HTTP and never sends the OAuth session cookie, so Google login fails. Set TRUST_PROXY to the number of proxies in front of this app.'
    )
  }

  problems.push(...flagsKeyProblems(env))
  warnOnUntrustedProxyForAnalytics(env, warn)
  warnOnHalfTimelineConfig(env, warn)

  if (problems.length === 0) return
  const list = problems.map((problem) => `  - ${problem}`).join('\n')
  throw new Error(`Inconsistent environment:\n${list}`)
}
