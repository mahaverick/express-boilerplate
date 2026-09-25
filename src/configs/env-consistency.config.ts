// src/configs/env-consistency.config.ts
//
// Cross-field rules the schema cannot hold: EnvSchema carries no
// object-level .refine(), because getDatabaseUrl() needs EnvSchema.pick().
// getEnv() stays a pure parse; index.ts runs these checks once, at boot.
import { isCookieSecure, trustProxySetting, type Env } from '@/configs/env.config'
import { SERVER_DRAIN_TIMEOUT_MS } from '@/constants/global.constants'

/**
 * Variables that were renamed, mapped to their new names. Setting an old
 * name refuses boot: the schema no longer reads it, so it would otherwise be
 * ignored in silence.
 */
export const REMOVED_ENV_NAMES: Readonly<Record<string, string>> = Object.freeze({
  SMTP_USER: 'SMTP_USERNAME',
  SMTP_PASS: 'SMTP_PASSWORD',
  SMTP_CONNECTION_TIMEOUT: 'SMTP_CONNECTION_TIMEOUT_MS',
  SMTP_GREETING_TIMEOUT: 'SMTP_GREETING_TIMEOUT_MS',
  SMTP_SOCKET_TIMEOUT: 'SMTP_SOCKET_TIMEOUT_MS',
  QUEUE_PREFIX: 'REDIS_KEY_PREFIX',
})

// Time left after a hung send gives up, for the database, Redis, queue and
// OTel closes that run after the workers close.
const SHUTDOWN_HEADROOM_MS = 5000

const LOCAL_SMTP_HOSTS = new Set(['localhost', '127.0.0.1'])
const MAILPIT_SMTP_PORT = 1025
const PLACEHOLDER_MAIL_FROM = 'no-reply@example.com'

/**
 * Old variable names still present in the raw environment.
 * @param raw - The unparsed environment, normally `process.env`.
 * @returns One message per old name that is set to a non-empty value.
 */
function renamedVariableProblems(raw: Record<string, string | undefined>): string[] {
  // An empty value counts as unset, the same rule parseEnv applies.
  return Object.entries(REMOVED_ENV_NAMES)
    .filter(([oldName]) => (raw[oldName] ?? '') !== '')
    .map(
      ([oldName, newName]) =>
        `${oldName} was renamed to ${newName}. Rename it where this environment is set.`
    )
}

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
  return problems
}

/**
 * Refuses unsafe or stale configuration at boot; throws Error with one actionable message.
 *
 * Every problem found goes into that one message, so an operator fixes them
 * all in one pass. Warnings go to `warn` and never stop boot.
 * @param env - The validated environment from `getEnv()`.
 * @param raw - The unparsed environment, normally `process.env`; only read for renamed names.
 * @param warn - Receives each warning message.
 * @throws {Error} Listing every problem, when there is at least one.
 */
export function assertEnvConsistent(
  env: Env,
  raw: Record<string, string | undefined>,
  warn: (message: string) => void
): void {
  const problems = renamedVariableProblems(raw)
  const isLocal = env.APP_ENV === 'local'

  if (!isLocal && env.NODE_ENV !== 'production') {
    problems.push(
      `NODE_ENV is ${env.NODE_ENV}, but APP_ENV is ${env.APP_ENV}. Set NODE_ENV=production: outside production, Express's built-in error handler sends stack traces.`
    )
  }
  if (!isLocal) problems.push(...mailpitDefaultProblems(env))

  // Half a credential pair means no auth is attempted at all, so every send
  // to a provider that needs it fails, silently (Ruling G, mailer.service.ts).
  if ((env.SMTP_USERNAME === undefined) !== (env.SMTP_PASSWORD === undefined)) {
    const [presentName, missingName] =
      env.SMTP_USERNAME === undefined
        ? ['SMTP_PASSWORD', 'SMTP_USERNAME']
        : ['SMTP_USERNAME', 'SMTP_PASSWORD']
    problems.push(
      `Only ${presentName} is set. Set ${missingName} too, or neither (Mailpit needs neither).`
    )
  }

  // gracefulShutdown drains HTTP first, then waits for the in-flight send,
  // so the SMTP timeouts get what SHUTDOWN_TIMEOUT_MS leaves after the drain
  // and the headroom. The sum covers one address and no DNS time, so it is a
  // sanity check, not a bound on a send.
  const smtpChainMs =
    env.SMTP_CONNECTION_TIMEOUT_MS + env.SMTP_GREETING_TIMEOUT_MS + env.SMTP_SOCKET_TIMEOUT_MS
  const smtpBudgetMs = env.SHUTDOWN_TIMEOUT_MS - SERVER_DRAIN_TIMEOUT_MS - SHUTDOWN_HEADROOM_MS
  if (smtpChainMs > smtpBudgetMs) {
    const message = `SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS is ${String(smtpChainMs)} ms, more than the ${String(smtpBudgetMs)} ms that SHUTDOWN_TIMEOUT_MS (${String(env.SHUTDOWN_TIMEOUT_MS)} ms) leaves after the ${String(SERVER_DRAIN_TIMEOUT_MS)} ms HTTP drain and ${String(SHUTDOWN_HEADROOM_MS)} ms of headroom, so a send that hangs at each stage, even against a single address, outlasts graceful shutdown and the process exits 1 before closing its connections. Lower the SMTP timeouts, or raise SHUTDOWN_TIMEOUT_MS together with the orchestrator's termination grace period.`
    if (isLocal) warn(message)
    else problems.push(message)
  }

  // express-session only sends a Secure cookie when req.secure is true,
  // which behind a TLS-terminating proxy needs TRUST_PROXY.
  if (
    isCookieSecure(env) &&
    env.GOOGLE_CLIENT_ID !== undefined &&
    trustProxySetting(env.TRUST_PROXY) === false
  ) {
    warn(
      'Auth cookies are Secure (COOKIE_SECURE, on by default outside local) and TRUST_PROXY is false. Behind a TLS-terminating proxy, express-session then sees plain HTTP and never sends the OAuth session cookie, so Google login fails. Set TRUST_PROXY to the number of proxies in front of this app.'
    )
  }

  if (problems.length === 0) return
  const list = problems.map((problem) => `  - ${problem}`).join('\n')
  throw new Error(`Inconsistent environment:\n${list}`)
}
