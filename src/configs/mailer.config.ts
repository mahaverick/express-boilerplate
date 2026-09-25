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
import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { getEnv, type Env } from '@/configs/env.config'
import { logger } from '@/services/logger.service'

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
 *
 * `connectionTimeout`/`greetingTimeout`/`socketTimeout` are always set, never
 * left to nodemailer's own defaults (2 minutes / 30 seconds / 10 minutes).
 * These bound a TIMING oracle, not merely a resource leak — see
 * `SMTP_CONNECTION_TIMEOUT`'s own comment (env.config.ts) for why a hung
 * SMTP host must not be able to hold `sendMail` (mailer.service.ts) open
 * long enough to be measurably different from the no-send branch.
 * @param env - The SMTP slice of the validated environment.
 * @returns Options for `nodemailer.createTransport`.
 */
export function mailTransportOptions(
  env: Pick<
    Env,
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_USER'
    | 'SMTP_PASS'
    | 'SMTP_CONNECTION_TIMEOUT'
    | 'SMTP_GREETING_TIMEOUT'
    | 'SMTP_SOCKET_TIMEOUT'
  >
): SMTPTransport.Options {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    connectionTimeout: env.SMTP_CONNECTION_TIMEOUT,
    greetingTimeout: env.SMTP_GREETING_TIMEOUT,
    socketTimeout: env.SMTP_SOCKET_TIMEOUT,
    ...(env.SMTP_USER !== undefined &&
      env.SMTP_PASS !== undefined && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }),
  }
}

/**
 * Whether the transporter must require TLS rather than merely negotiating
 * it opportunistically.
 *
 * Keyed on `NODE_ENV`, NOT on `SMTP_HOST !== 'localhost'` (an earlier
 * version of this file used that check): a devcontainer or docker-compose
 * network can legitimately reach Mailpit as `SMTP_HOST=mailpit` rather than
 * `localhost` (docker-compose.yml's own header comment documents
 * container-to-container addressing for exactly this shape), and a
 * host-name check would then require TLS against a Mailpit that cannot
 * speak it — Ruling G (mailer.service.ts) makes that failure SILENT to
 * every caller, so this would be a footgun with no error message pointing
 * at its own cause. Outside production,
 * nodemailer still negotiates STARTTLS opportunistically when a real
 * provider offers it — this flag only forces the requirement, it does not
 * forbid TLS.
 *
 * A separate, pure function — not inlined into `getMailTransporter` below —
 * for the same testability reason as `mailTransportOptions`:
 * `getMailTransporter` reads the memoised `getEnv()` exactly once, so this
 * decision cannot otherwise be exercised for both branches in one worker.
 * @param env - The `NODE_ENV` slice of the validated environment.
 * @returns True only in production.
 */
export function requiresTls(env: Pick<Env, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'production'
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
 * literal property on the object literal passed to `createTransport` — see
 * `requiresTls`'s own comment for the policy this expresses. It has to be
 * written directly on the object literal (never behind a spread of a
 * function call) for an unrelated, second reason: sonarjs's S5332 rule
 * (`sonarjs/no-clear-text-protocols`) statically checks exactly this call
 * for a `secure`/`requireTLS`/`port` property it can prove is not hardcoded
 * `false`, and it can only see a property written directly on the object
 * literal at the call site — not one produced by a spread of a function
 * call (verified empirically: spreading `mailTransportOptions(env)` alone
 * still reports, because the rule's own `getValueOfExpression` helper does
 * not resolve through a `CallExpression`). `requireTLS` is placed AFTER
 * that spread specifically so this check finds it without needing to
 * resolve the spread at all.
 *
 * Return type is `Transporter<SMTPTransport.SentMessageInfo>` — an explicit
 * ANNOTATION, not `ReturnType<typeof nodemailer.createTransport>`. That
 * distinction is load-bearing, not stylistic: `createTransport` is a
 * seven-overload function (see node_modules/nodemailer/dist/cjs/nodemailer.d.ts),
 * and `ReturnType<>` on an overloaded function resolves the LAST signature —
 * here, the catch-all `(transporter?: TransportConfig | Transport<any> |
 * string, ...): Mail<any>`. An earlier version of this file used
 * `ReturnType<>` for exactly that reason (to avoid retyping the signature)
 * and silently inherited `Mail<any>`, which made `sendMail(...)`'s resolved
 * value `any` everywhere it was used — `mailer.service.ts` carried a cast to
 * paper over it. Annotating the SPECIFIC overload's return type directly
 * selects the correct one instead.
 *
 * Warns (does not throw) when exactly one of `SMTP_USER`/`SMTP_PASS` is
 * set. `mailTransportOptions` already handles this safely — no `auth` is
 * attempted, same as neither being set (see its own comment for why there
 * is no schema-level refinement instead) — but "safely" here means every
 * send against a provider that requires auth fails with `EAUTH`, and Ruling
 * G (mailer.service.ts) makes that failure invisible to every caller. This
 * is the one place with the full env available to restore that signal at
 * boot, the moment the transporter is actually built, rather than leaving
 * an operator to notice only from a stream of `error_code: 'EAUTH'` rows in
 * `email_logs`.
 * @returns The shared SMTP transporter.
 */
export const getMailTransporter: () => Transporter<SMTPTransport.SentMessageInfo> = (() => {
  let cached: Transporter<SMTPTransport.SentMessageInfo> | undefined
  return (): Transporter<SMTPTransport.SentMessageInfo> => {
    if (!cached) {
      const env = getEnv()
      if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined)) {
        logger.warn(
          'Exactly one of SMTP_USER/SMTP_PASS is set — no SMTP authentication will be attempted, so every send will fail with EAUTH against a provider that requires it. Set both, or neither (Mailpit needs neither).'
        )
      }
      cached = nodemailer.createTransport(
        { ...mailTransportOptions(env), requireTLS: requiresTls(env) },
        { from: env.MAIL_FROM }
      )
    }
    return cached
  }
})()
