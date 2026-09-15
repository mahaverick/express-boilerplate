// src/configs/mailer.config.ts
//
// ONE transporter per process, created LAZILY on first use — not at module
// scope, unlike database.service.ts's postgres pool. Two reasons this one
// must differ from that precedent: (1) mailer.service.ts's `sendMail`
// (Ruling G, task-2-brief.md's controller addendum) must never let a mail
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
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { getEnv, type Env } from '@/configs/env.config'

/**
 * Build nodemailer's `createTransport` options from the SMTP slice of the
 * validated environment.
 *
 * Pulled out as its own pure function — not inlined into
 * `getMailTransporter` below — specifically so a unit test can vary
 * SMTP_USER/SMTP_PASS independently of `process.env`: `getMailTransporter`
 * reads the memoised `getEnv()`, which cannot be changed between test cases
 * once any module in the worker has already called it (see env.config.ts's
 * header comment on `getEnv`'s memoisation).
 *
 * `auth` is included only when BOTH `SMTP_USER` and `SMTP_PASS` are set.
 * Mailpit needs neither, so the common local-dev case is `{ host, port }`
 * with no `auth` key at all — nodemailer treats a present-but-incomplete
 * `auth` object (e.g. a `user` with `pass: undefined`) as a real
 * authentication attempt, which fails at the first send as an opaque SMTP
 * error rather than at boot as a configuration one. There is deliberately no
 * schema-level "both or neither" validation for this pair — see
 * env.config.ts's own comment on `SMTP_PASS` for why: `EnvSchema` cannot
 * carry a whole-object `.refine()` without breaking
 * `EnvSchema.pick({ DATABASE_URL: true })`, which `getDatabaseUrl()` (also
 * env.config.ts) needs for drizzle-kit.
 * @param env - The `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` slice of the validated environment.
 * @returns Options for `nodemailer.createTransport`.
 */
export function mailTransportOptions(
  env: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS'>
): SMTPTransport.Options {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    ...(env.SMTP_USER !== undefined &&
      env.SMTP_PASS !== undefined && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }),
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
 * `requireTLS` is added here, not inside `mailTransportOptions`, as a
 * literal property on the object literal passed to `createTransport` —
 * `env.SMTP_HOST !== 'localhost'` in source, at this exact call. Two
 * reasons it has to look like that: first, the actual policy — plaintext is
 * accepted ONLY talking to local Mailpit, and any other host is assumed to
 * be a real provider over the public internet, which must negotiate TLS.
 * Second, sonarjs's S5332 rule (`sonarjs/no-clear-text-protocols`)
 * statically checks exactly this call for a `secure`/`requireTLS`/`port`
 * property it can prove is not hardcoded `false` — and it can only see a
 * property written directly on the object literal at the call site, not one
 * produced by a spread of a function call (verified empirically: spreading
 * `mailTransportOptions(env)` alone still reports, because the rule cannot
 * resolve properties through a `CallExpression`). `requireTLS` is placed
 * AFTER that spread specifically so this check finds it without needing to
 * resolve the spread at all.
 * @returns The shared SMTP transporter.
 */
export const getMailTransporter: () => ReturnType<typeof nodemailer.createTransport> = (() => {
  let cached: ReturnType<typeof nodemailer.createTransport> | undefined
  return (): ReturnType<typeof nodemailer.createTransport> => {
    if (!cached) {
      const env = getEnv()
      cached = nodemailer.createTransport(
        { ...mailTransportOptions(env), requireTLS: env.SMTP_HOST !== 'localhost' },
        { from: env.MAIL_FROM }
      )
    }
    return cached
  }
})()
