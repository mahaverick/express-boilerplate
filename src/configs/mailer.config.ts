// src/configs/mailer.config.ts
//
// ONE transporter per process, created LAZILY on first use — not at module
// scope, unlike database.service.ts's postgres pool. Two reasons this one
// must differ from that precedent: (1) mailer.service.ts's `sendMail`
// (Ruling G, that file's header comment) must never let a mail
// failure propagate to an HTTP response, and a module-scope
// `nodemailer.createTransport(...)` that read `getEnv()` eagerly would force
// SMTP_* to resolve merely by importing this module's graph — including from
// a unit test that never sends mail. (2) `getEnv()` itself is documented
// lazy for the identical reason (env.config.ts's own header comment): a
// module-scope read throws during import resolution, which is the exact
// failure mode this repo was rebuilt to remove. This module's memoisation
// mirrors `getEnv`'s own IIFE-closure pattern for the same reason that one
// gives: the reassignment stays local to the function that owns it
// (satisfying unicorn/no-top-level-assignment-in-function without disabling
// it) while the once-per-process behaviour is unchanged.
import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { getEnv, requiresSmtpTls, type Env } from '@/configs/env.config'

/**
 * Build nodemailer's `createTransport` options from the SMTP slice of the
 * validated environment.
 *
 * Pulled out as its own pure function — not inlined into
 * `getMailTransporter` below — specifically so a unit test can vary
 * SMTP_USERNAME/SMTP_PASSWORD independently of `process.env`:
 * `getMailTransporter` reads the memoised `getEnv()`, which cannot be changed
 * between test cases once any module in the worker has already called it
 * (see env.config.ts's header comment on `getEnv`'s memoisation).
 *
 * `auth` is included only when BOTH `SMTP_USERNAME` and `SMTP_PASSWORD` are
 * set. Mailpit needs neither, so the common local-dev case is
 * `{ host, port }` with no `auth` key at all — nodemailer treats a
 * present-but-incomplete `auth` object (e.g. a `user` with `pass: undefined`)
 * as a real authentication attempt, which fails at the first send as an
 * opaque SMTP error rather than at boot as a configuration one. The schema
 * has no "both or neither" rule for this pair, because `EnvSchema` cannot
 * carry a whole-object `.refine()` without breaking
 * `EnvSchema.pick({ DATABASE_URL: true })`, which `getDatabaseUrl()` needs
 * for drizzle-kit. `assertEnvConsistent` (env-consistency.config.ts) refuses
 * a half-set pair at boot instead, so here both are set or neither is.
 *
 * `connectionTimeout`/`greetingTimeout`/`socketTimeout` are always set, never
 * left to nodemailer's own defaults (2 minutes / 30 seconds / 10 minutes).
 * They bound how long an SMTP host that stops responding holds an
 * email-worker slot and delays graceful shutdown — see the SMTP timeout
 * group's comment (env.config.ts).
 * @param env - The SMTP slice of the validated environment.
 * @returns Options for `nodemailer.createTransport`.
 */
export function mailTransportOptions(
  env: Pick<
    Env,
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_USERNAME'
    | 'SMTP_PASSWORD'
    | 'SMTP_CONNECTION_TIMEOUT_MS'
    | 'SMTP_GREETING_TIMEOUT_MS'
    | 'SMTP_SOCKET_TIMEOUT_MS'
  >
): SMTPTransport.Options {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    connectionTimeout: env.SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: env.SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: env.SMTP_SOCKET_TIMEOUT_MS,
    ...(env.SMTP_USERNAME !== undefined &&
      env.SMTP_PASSWORD !== undefined && {
        auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
      }),
  }
}

/**
 * The single nodemailer transporter for this process, created on first call
 * and memoised for the process's lifetime — see this file's header comment
 * for why lazily rather than at module scope.
 *
 * `MAIL_FROM` is passed as `createTransport`'s second argument (its message
 * defaults), not read again inside `mailer.service.ts` — every message this
 * transporter sends carries it automatically, so `sendMail`'s own input
 * never needs a `from` field a caller could otherwise override by mistake.
 *
 * `requireTLS` comes from `requiresSmtpTls` (env.config.ts): required outside
 * `APP_ENV=local`. It is keyed on APP_ENV, not SMTP_HOST, because compose can
 * reach Mailpit as `mailpit`, and Ruling G (mailer.service.ts) would make a
 * TLS failure against it silent. On local, nodemailer still negotiates
 * STARTTLS when a server offers it.
 *
 * `requireTLS` is written directly on the object literal passed to
 * `createTransport`, after the spread, never behind a spread of a function
 * call: sonarjs's S5332 rule (`sonarjs/no-clear-text-protocols`) checks this
 * call for a `secure`/`requireTLS`/`port` property it can prove is not
 * hardcoded `false`, and it cannot see through a spread of a call
 * expression (verified empirically: spreading `mailTransportOptions(env)`
 * alone still reports).
 *
 * Return type is `Transporter<SMTPTransport.SentMessageInfo>` — an explicit
 * ANNOTATION, not `ReturnType<typeof nodemailer.createTransport>`. That
 * distinction is load-bearing, not stylistic: `createTransport` is a
 * seven-overload function (see node_modules/nodemailer/dist/cjs/nodemailer.d.ts),
 * and `ReturnType<>` on an overloaded function resolves the LAST signature —
 * here, the catch-all `(transporter?: TransportConfig | Transport<any> |
 * string, ...): Mail<any>`, which would make `sendMail(...)`'s resolved
 * value `any` everywhere it is used. Annotating the SPECIFIC overload's
 * return type directly selects the correct one instead.
 * @returns The shared SMTP transporter.
 */
export const getMailTransporter: () => Transporter<SMTPTransport.SentMessageInfo> = (() => {
  let cached: Transporter<SMTPTransport.SentMessageInfo> | undefined
  return (): Transporter<SMTPTransport.SentMessageInfo> => {
    if (!cached) {
      const env = getEnv()
      cached = nodemailer.createTransport(
        { ...mailTransportOptions(env), requireTLS: requiresSmtpTls(env) },
        { from: env.MAIL_FROM }
      )
    }
    return cached
  }
})()
