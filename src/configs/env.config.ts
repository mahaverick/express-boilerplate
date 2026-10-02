/**
 * @file The validated environment. Every module reads configuration from
 * `getEnv()`, never from `process.env` (`no-restricted-properties` enforces
 * it), so a missing or malformed variable fails at boot in one readable list
 * instead of surfacing as `undefined` far from its cause.
 */
import { config } from 'dotenv'
import { z } from 'zod'
import { parseDurationMs } from '@/utilities/duration.utilities'
import { EMAIL_DOMAIN_PATTERN } from '@/utilities/email.utilities'

// Skipped under Vitest so a developer's .env never leaks into the suite; `quiet` keeps stdout clean.
if (!process.env.VITEST) {
  config({ quiet: true })
}

const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug'])

const AppEnvSchema = z.enum(['local', 'dev', 'qa', 'prod'])

/**
 * The deployment an `APP_ENV` value names.
 */
export type AppEnv = z.infer<typeof AppEnvSchema>

const TOP_LEVEL_LABEL = /^[a-z]{2,}$/

/**
 * Whether `value` is a lowercase domain: a dotted hostname by
 * `EMAIL_DOMAIN_PATTERN`, the shape the audit log stores for an auto-join,
 * whose last label is two or more letters.
 * @param value - One trimmed entry of PLATFORM_EMAIL_DOMAINS.
 * @returns True for a domain such as `example.com`.
 */
function isLowercaseDomain(value: string): boolean {
  return EMAIL_DOMAIN_PATTERN.test(value) && TOP_LEVEL_LABEL.test(value.split('.').at(-1) ?? '')
}

const NO_QUERY_OR_FRAGMENT = 'must not contain a query (?) or a fragment (#)'

/**
 * Whether a URL string carries no `?` or `#`. Checked on the raw text because
 * `new URL()` reports an empty `search` and `hash` for a bare trailing `?` or `#`.
 * @param value - A URL that already passed `z.url()`.
 * @returns True when the string has neither character.
 */
function hasNoQueryOrFragment(value: string): boolean {
  return !value.includes('?') && !value.includes('#')
}

/**
 * Every variable this app reads. `.describe()` text is what `pnpm env:example`
 * and `pnpm env:table` publish. URL fields use `z.url({ protocol: /^https?$/ })`,
 * not `z.httpUrl()`, which requires a dotted public hostname and so rejects
 * `localhost` and Docker service names. No object-level `.refine()`: it would
 * break `getDatabaseUrl()`'s `.pick()`, so cross-field rules live in
 * `assertEnvConsistent` (env-consistency.config.ts). Placeholder secrets are
 * required, so a missing one fails at boot by name.
 */
const EnvSchema = z.object({
  /**
   * Required with no default, so a deploy that forgets to name its environment
   * refuses to boot. `.meta({ example })` is the value `pnpm env:example` writes.
   */
  APP_ENV: AppEnvSchema.describe(
    'Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.'
  ).meta({ example: 'local' }),
  /**
   * Required alongside APP_ENV because Express reads it itself (`app.get('env')`).
   */
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .describe(
      'Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.'
    )
    .meta({ example: 'development' }),
  APP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(4040)
    .describe('Port the HTTP server listens on. Defaults to 4040.'),

  APP_URL: z
    .url({ protocol: /^https?$/ })
    .describe(
      'Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.'
    ),
  WEB_URL: z
    .url({ protocol: /^https?$/ })
    .refine(hasNoQueryOrFragment, NO_QUERY_OR_FRAGMENT)
    .describe(
      'Public origin of the frontend, with no query or fragment. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.'
    ),
  APEX_URL: z
    .url({ protocol: /^https?$/ })
    .refine(hasNoQueryOrFragment, NO_QUERY_OR_FRAGMENT)
    .optional()
    .describe(
      'Public origin of the Apex staff dashboard, e.g. https://admin.example.com, with no query or fragment. When set, platform-tenant invitation links, and the verification, password-reset and Google sign-in flows started with app "apex", point here instead of WEB_URL. Unset sends every link to WEB_URL. Google sign-in from a host other than APP_URL also needs COOKIE_DOMAIN covering both.'
    ),

  DATABASE_URL: z
    .url()
    .describe(
      'Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.'
    ),
  REDIS_URL: z
    .url()
    .describe(
      'Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.'
    ),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections."
    ),
  /**
   * 0 is allowed: `databaseClientOptions()` then sends no statement_timeout.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30_000)
    .describe(
      "Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there."
    ),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32)
    .describe(
      'Signs and verifies access tokens (session.service.ts). Any 32+ character string works; use `openssl rand -hex 32`.'
    ),
  SESSION_SECRET: z
    .string()
    .min(32)
    .describe(
      'Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.'
    ),

  /**
   * Optional: absent disables Google login. `configurePassport()`
   * (passport.config.ts) refuses boot when it is set without
   * GOOGLE_CLIENT_SECRET.
   */
  GOOGLE_CLIENT_ID: z
    .string()
    .optional()
    .describe('Google OAuth 2.0 client ID. When absent, Google login is disabled.'),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .optional()
    .describe('Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.'),

  /**
   * Refined by parsing, so an unparseable duration fails inside `safeParse`
   * with every other invalid variable. `denySession` (session-denylist.service.ts)
   * sets a denylist entry's TTL from this value on the denying process: during
   * a rolling deploy that raises it, an old-env process can write an entry that
   * expires before a token a new-env process minted, and that token is honoured
   * again for the rest of its life.
   */
  ACCESS_TOKEN_TTL: z
    .string()
    .default('15m')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message: 'ACCESS_TOKEN_TTL must be a duration string ms() can parse, e.g. "15m" or "900000".',
    })
    .describe(
      'Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.'
    ),
  REFRESH_TOKEN_TTL: z
    .string()
    .default('30d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'REFRESH_TOKEN_TTL must be a duration string ms() can parse, e.g. "30d" or "2592000000".',
    })
    .describe(
      'Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.'
    ),

  /**
   * Absolute cap, never reset by rotation. REFRESH_TOKEN_TTL slides on every
   * rotation, so without this cap a session refreshed regularly, or a stolen
   * refresh cookie, would live forever.
   */
  SESSION_ABSOLUTE_TTL: z
    .string()
    .default('30d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'SESSION_ABSOLUTE_TTL must be a duration string ms() can parse, e.g. "30d" or "2592000000".',
    })
    .describe(
      'Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.'
    ),

  EMAIL_VERIFICATION_TTL: z
    .string()
    .default('24h')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'EMAIL_VERIFICATION_TTL must be a duration string ms() can parse, e.g. "24h" or "86400000".',
    })
    .describe(
      'How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.'
    ),

  /**
   * Its own variable, shorter than EMAIL_VERIFICATION_TTL: redeeming the link
   * sets a new password and revokes every session.
   */
  PASSWORD_RESET_TTL: z
    .string()
    .default('1h')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'PASSWORD_RESET_TTL must be a duration string ms() can parse, e.g. "1h" or "3600000".',
    })
    .describe(
      'How long a password-reset link stays valid. Defaulted to 1h — shorter than EMAIL_VERIFICATION_TTL, because redeeming it grants immediate account takeover rather than merely proving mailbox ownership.'
    ),

  /**
   * Longer than PASSWORD_RESET_TTL: the recipient of a staff-created account
   * did not ask for the mail. The link is single-use either way.
   */
  ACCOUNT_SETUP_TTL: z
    .string()
    .default('24h')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'ACCOUNT_SETUP_TTL must be a duration string ms() can parse, e.g. "24h" or "86400000".',
    })
    .describe(
      'How long the set-password link mailed to a staff-created account stays valid. Defaulted to 24h: the recipient did not ask for the mail, so it must last until the next working day; the link is single-use either way.'
    ),

  INVITATION_TTL: z
    .string()
    .default('7d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message: 'INVITATION_TTL must be a duration string ms() can parse, e.g. "7d" or "604800000".',
    })
    .describe(
      'How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "7d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 7d.'
    ),

  /**
   * Defaults to `false`, which fails towards over-limiting: behind a proxy
   * every IP-keyed limiter shares one bucket, but no header can bypass them.
   * `true` is refused because X-Forwarded-For is client-written, so trusting
   * every hop gives each request a fresh rate-limit bucket; a hop count or an
   * address list covers every legitimate use.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine((value) => value.trim().toLowerCase() !== 'true', {
      message:
        'TRUST_PROXY must not be "true": trusting every hop lets any client spoof X-Forwarded-For and bypass the IP-keyed rate limiters. Use the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted addresses/subnets (e.g. "10.0.0.0/8") or presets ("loopback", "uniquelocal").',
    })
    .describe(
      'How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.'
    ),

  /**
   * No schema default: it depends on APP_ENV, which `.default()` cannot read,
   * so `isCookieSecure()` applies it.
   */
  COOKIE_SECURE: z
    .stringbool()
    .optional()
    .describe(
      'Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.'
    ),
  COOKIE_DOMAIN: z
    .string()
    .refine((value) => !/[\s/:]/.test(value), {
      message:
        'COOKIE_DOMAIN must be a bare domain such as "example.com", with no scheme, port or path.',
    })
    .optional()
    .describe(
      "Domain attribute for the refresh-token and OAuth session cookies, e.g. \"example.com\" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. With COOKIE_SECURE on, the refresh cookie is __Secure-refreshToken when this is set and __Host-refreshToken (Path=/) when it is not, so setting or unsetting it on a live deployment signs users in again once. With COOKIE_SECURE on, an unprefixed refreshToken cookie is also read, then cleared in its host-only form and under this domain; that fallback is removed in the next major version. Within one name the API reads the most recently created cookie. Reverting to an earlier value is the exception: the browser keeps that cookie's original creation time, so the other scope's cookie reads as newer and refresh fails until the user logs in again or it expires."
    ),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .describe(
      'Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.'
    ),

  /**
   * Grants viewer only, and only to a verified address. Parsed by
   * `parsePlatformEmailDomains` (platform.service.ts).
   */
  PLATFORM_EMAIL_DOMAINS: z
    .string()
    .refine((value) => value.split(',').every((domain) => isLowercaseDomain(domain.trim())), {
      message:
        'PLATFORM_EMAIL_DOMAINS must be lowercase domains separated by commas, e.g. "example.com,example.org".',
    })
    .optional()
    .describe(
      'Comma-separated email domains, e.g. "example.com,example.org". A user whose verified address is on one of them joins the platform tenant as viewer, when the address is verified and at every sign-in. Viewer can see every tenant and change nothing; a higher platform role needs an explicit grant (pnpm platform:grant, or an invitation to the platform tenant). Only the exact domain after the last "@" matches, never a subdomain. Empty means nobody joins automatically.'
    ),

  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe('Absent means tracing is disabled; the SDK is never started.'),
  /**
   * Declared for `pnpm env:example` only: tracing.ts loads before `getEnv()`
   * and reads `process.env` itself, with its own copy of this default. Keep
   * the two in sync by hand.
   */
  OTEL_SERVICE_NAME: z
    .string()
    .min(1)
    .default('express-boilerplate')
    .describe('Service name reported in OTEL traces.'),
  /**
   * `silent` is added here, not to LogLevelSchema: SLACK_LOG_LEVEL shares that
   * schema, and `toPinoLevel()` (logger.service.ts) maps an unknown level to
   * `info`, so a silent Slack level would send everything from info up.
   */
  LOG_LEVEL: z
    .enum([...LogLevelSchema.options, 'silent'])
    .default('info')
    .describe(
      'Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).'
    ),
  /**
   * No schema default, as for COOKIE_SECURE: `logFormat()` derives it.
   */
  LOG_FORMAT: z
    .enum(['json', 'pretty'])
    .optional()
    .describe(
      'Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.'
    ),

  SLACK_WEBHOOK_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(
      'Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.'
    ),
  SLACK_LOG_LEVEL: LogLevelSchema.default('error').describe(
    'Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.'
  ),

  /**
   * `z.stringbool()`, not `z.coerce.boolean()`: `Boolean("false")` is true, so
   * coercion would turn `WORKER_ENABLED=false` into enabled.
   */
  WORKER_ENABLED: z
    .stringbool()
    .default(true)
    .describe(
      'Whether the BullMQ workers (email, notification and maintenance) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true. The daily retention purge runs only where this is true.'
    ),
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      'Jobs the email and notification workers each process at once, per process. Defaults to 5. The maintenance worker always runs one job at a time.'
    ),
  RETENTION_TOKENS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(7)
    .describe(
      'Days to keep a user_tokens row once it has expired, or once it was revoked without ever being used (logout, reuse, password change). A token rotated away is kept until it expires, because reuse detection needs it. 0 never purges; at most 36500. Defaults to 7.'
    ),
  RETENTION_INVITATIONS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(30)
    .describe(
      'Days to keep a tenant invitation after the latest of its expiry, acceptance and revocation. 0 never purges; at most 36500. Defaults to 30.'
    ),
  RETENTION_EMAIL_LOGS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(90)
    .describe(
      "Days to keep email tracking rows: each email message with its send attempts (email_logs) and provider events, dated by the message's creation; an attempt row with no message is dated by its own. Suppressions never expire. 0 never purges; at most 36500. Defaults to 90."
    ),
  RETENTION_NOTIFICATIONS_READ_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(90)
    .describe(
      'Days to keep a notification after it was read. 0 never purges; at most 36500. Defaults to 90.'
    ),
  RETENTION_NOTIFICATIONS_UNREAD_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(365)
    .describe(
      'Days to keep a notification nobody read, counted from when it was created. 0 never purges; at most 36500. Defaults to 365.'
    ),
  RETENTION_AUDIT_LOGS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(36_500)
    .default(0)
    .describe(
      'Days to keep an audit_logs row. Defaults to 0, which keeps the audit log forever. Set a number of days, at most 36500, only where your compliance rules allow deleting audit history.'
    ),
  ONBOARDING_STUCK_AFTER_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(36_500)
    .default(7)
    .describe(
      'Days without onboarding progress after which a tracked tenant that is not complete or dismissed counts as stuck in the staff funnel and lists. At least 1, at most 36500. Defaults to 7.'
    ),
  /**
   * `redisKey()` (redis.service.ts) joins this and each part with `:`, so a
   * trailing colon would double it.
   */
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9:_-]*$/, 'Use lowercase letters, digits, ":", "_" and "-"')
    .refine((value) => !value.endsWith(':'), 'No trailing colon: keys are joined with ":"')
    .default('express-boilerplate')
    .describe(
      'Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`), the platform-access audit dedupe (`<prefix>:audit`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.'
    ),

  /**
   * The heartbeat keeps the stream alive through a proxy or load balancer
   * that times out an idle socket. `.env.test` shortens it.
   */
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      'Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).'
    ),
  /**
   * Per process, because the stream registry is in memory (lifecycle.service.ts).
   * Bounds the file descriptors and listeners one account can hold open.
   */
  SSE_MAX_STREAMS_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      'Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).'
    ),

  /**
   * SMTP defaults point at the compose Mailpit, so a fresh clone sends mail
   * with no configuration. SMTP_USERNAME and SMTP_PASSWORD stay optional:
   * Mailpit checks neither.
   */
  SMTP_HOST: z
    .string()
    .min(1)
    .default('127.0.0.1')
    .describe(
      'SMTP server host. Defaults to 127.0.0.1, where the compose Mailpit service listens; an IP literal skips a DNS lookup on every send.'
    ),
  SMTP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(1025)
    .describe("SMTP server port. Defaults to 1025 — Mailpit's SMTP port."),
  SMTP_USERNAME: z
    .string()
    .optional()
    .describe(
      'SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.'
    ),
  SMTP_PASSWORD: z
    .string()
    .optional()
    .describe(
      'SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.'
    ),
  MAIL_FROM: z
    .email()
    .default('no-reply@example.com')
    .describe(
      'The From address of the general sender: every email whose links carry no token (password changed, registration attempt), and token emails too while MAIL_FROM_TRANSACTIONAL is unset. Mailpit accepts any value; a real provider may require this to be a verified sender.'
    ),
  /**
   * No schema default: it falls back to MAIL_FROM, which `.default()` cannot
   * read, so `senderFor` (email-sender.utilities.ts) applies the fallback.
   */
  MAIL_FROM_TRANSACTIONAL: z
    .email()
    .optional()
    .describe(
      'The From address of the transactional sender: every email whose link carries a token (email verification, password reset, account setup, tenant invitation). Put it on a domain whose provider click tracking is off, since a tracked link is rewritten through the provider, token included. Unset uses MAIL_FROM; outside APP_ENV=local, boot warns when the two share a domain.'
    ),

  APP_NAME: z
    .string()
    .min(1)
    .default('Express Boilerplate')
    .describe(
      'Product name in outbound email copy and notification text: verification, password reset, password changed and invitation messages (auth.service.ts, verification.service.ts, tenant-invitation.service.ts). Defaults to "Express Boilerplate".'
    ),

  /**
   * Optional: absent leaves POST /api/v1/webhooks/email/resend answering
   * 404. Shape-checked here so a pasted API key (`re_…`) fails at boot, not
   * as a 401 on every delivery event.
   */
  RESEND_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_[A-Za-z\d+/]+={0,2}$/, 'must be a Resend signing secret: whsec_ then base64')
    .optional()
    .describe(
      "Signing secret of the Resend webhook endpoint (Resend dashboard, Webhooks, the endpoint's signing secret: whsec_ followed by base64). Enables POST /api/v1/webhooks/email/resend, which verifies each event's Svix signature with it; absent, that route answers 404. Subscribe the endpoint to the email.* events: delivered, delivery_delayed, bounced, complained, opened, clicked, failed and suppressed."
    ),
  /**
   * Not a credential: the fake adapter is registered only where
   * `isFakeEmailWebhookAllowed` holds (APP_ENV local), so this value signs
   * nothing that any deployed API accepts.
   */
  FAKE_EMAIL_WEBHOOK_SECRET: z
    .string()
    .min(1)
    .default('fake-webhook')
    .describe(
      'Signs local fake email webhook events (`pnpm email:fire-event`), as an HMAC-SHA256 hex digest in the x-fake-signature header. Read only when APP_ENV is local, the one environment that serves POST /api/v1/webhooks/email/fake. Defaults to "fake-webhook"; not a credential.'
    ),

  /**
   * Per-stage bounds, not a per-send deadline: DNS retries double this
   * timeout, the OS-lookup fallback has none, and a multi-address host can take
   * it once per address. No HTTP response waits on SMTP (sends run in
   * email.worker.ts); the bounds limit how long a hung send holds a worker slot
   * and delays `gracefulShutdown` (server.ts). `assertEnvConsistent` checks the
   * three SMTP timeouts against SHUTDOWN_TIMEOUT_MS at boot. If the Mailpit
   * integration tests time out on the greeting, raise SMTP_GREETING_TIMEOUT_MS
   * in `.env.test` and the CI env block, not this default.
   */
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3000)
    .describe(
      "Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query."
    ),
  SMTP_GREETING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000)
    .describe(
      "Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds."
    ),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7000)
    .describe(
      "Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes."
    ),

  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(25_000)
    .describe(
      "Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period."
    ),
})

/**
 * The validated, frozen environment every module consumes.
 */
export type Env = Readonly<z.infer<typeof EnvSchema>>

/**
 * The schema's field map, exported so `pnpm env:example` can walk it.
 */
export const EnvSchemaShape = EnvSchema.shape

/**
 * Validate an environment source and return it typed and frozen. An empty
 * string counts as unset, since a `.env` copied from `.env.example` keeps
 * `KEY=` lines and dotenv has no other way to say "unset".
 * @param source - Raw key/value pairs, normally `process.env`.
 * @returns The parsed environment.
 * @throws {Error} Listing every invalid or missing variable at once, each with its path.
 */
export function parseEnv(source: Record<string, unknown>): Env {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
  const result = EnvSchema.safeParse(present)

  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }

  return Object.freeze(result.data)
}

/**
 * Parse `process.env` once and memoise the result.
 *
 * Lazy, because a module-scope parse would throw during import resolution.
 * The cache lives in a closure so `unicorn/no-top-level-assignment-in-function`
 * holds without a disable.
 * @returns The validated environment.
 */
export const getEnv: () => Env = (() => {
  let cached: Env | undefined
  return (): Env => {
    cached ??= parseEnv(process.env)
    return cached
  }
})()

/**
 * Translate `TRUST_PROXY` into the value Express's `trust proxy` setting
 * expects.
 *
 * `"false"` disables it, a whole number is a hop count, and anything else is
 * passed to Express as an address list, which `proxy-addr` rejects by
 * throwing from `createApp()` at boot, so a typo stops the process instead of
 * misidentifying clients. `EnvSchema` refuses `"true"`.
 * @param value - The validated `TRUST_PROXY` value.
 * @returns `false`, a hop count, or the address list to hand to `app.set('trust proxy', ...)`.
 */
export function trustProxySetting(value: string): boolean | number | string {
  const normalised = value.trim()
  if (normalised.toLowerCase() === 'false') return false
  return /^\d+$/.test(normalised) ? Number(normalised) : normalised
}

/**
 * Whether the auth cookies (refresh token, OAuth session) carry `Secure`.
 *
 * An explicit COOKIE_SECURE wins; otherwise every APP_ENV but `local` is secure.
 * @param env - The COOKIE_SECURE and APP_ENV slice of the validated environment.
 * @returns True when the cookies must only travel over HTTPS.
 */
export function isCookieSecure(env: Pick<Env, 'COOKIE_SECURE' | 'APP_ENV'>): boolean {
  return env.COOKIE_SECURE ?? env.APP_ENV !== 'local'
}

/**
 * Console log format: an explicit LOG_FORMAT wins, otherwise `pretty` on
 * local and `json` everywhere else.
 * @param env - The LOG_FORMAT and APP_ENV slice of the validated environment.
 * @returns The format the logger writes.
 */
export function logFormat(env: Pick<Env, 'LOG_FORMAT' | 'APP_ENV'>): 'json' | 'pretty' {
  return env.LOG_FORMAT ?? (env.APP_ENV === 'local' ? 'pretty' : 'json')
}

/**
 * Whether SMTP must upgrade to TLS rather than only negotiating it when the
 * server offers it. Off on local only, where Mailpit cannot speak TLS.
 * @param env - The APP_ENV slice of the validated environment.
 * @returns True on every APP_ENV but `local`.
 */
export function requiresSmtpTls(env: Pick<Env, 'APP_ENV'>): boolean {
  return env.APP_ENV !== 'local'
}

/**
 * Whether the fake email webhook adapter is served: on local only, which is
 * also what the test suite runs as, so no deployed API accepts an event
 * signed with the default `FAKE_EMAIL_WEBHOOK_SECRET`.
 * @param env - The APP_ENV slice of the validated environment.
 * @returns True on APP_ENV `local` only.
 */
export function isFakeEmailWebhookAllowed(env: Pick<Env, 'APP_ENV'>): boolean {
  return env.APP_ENV === 'local'
}

/**
 * Validate and return only `DATABASE_URL`, without requiring the rest of the
 * schema.
 *
 * For `drizzle.config.ts`, so `drizzle-kit` needs no unrelated secrets.
 * `EnvSchema.pick()` keeps the `DATABASE_URL` rule single-sourced.
 * @returns The validated `DATABASE_URL`.
 * @throws {Error} When `DATABASE_URL` is missing or not a valid URL.
 */
export function getDatabaseUrl(): string {
  const result = EnvSchema.pick({ DATABASE_URL: true }).safeParse(process.env)

  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }

  return result.data.DATABASE_URL
}
