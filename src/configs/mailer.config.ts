/**
 * @file The SMTP transporter and its options, built lazily from the validated
 * environment.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { getEnv, requiresSmtpTls, type Env } from '@/configs/env.config'

/**
 * Build nodemailer's `createTransport` options from the SMTP slice of the
 * validated environment.
 *
 * A pure function so a unit test can vary the SMTP settings without the
 * memoised `getEnv()`. `auth` is included only when both `SMTP_USERNAME` and
 * `SMTP_PASSWORD` are set, since nodemailer treats a partial `auth` object as
 * a real login attempt; `assertEnvConsistent` refuses a half-set pair at boot.
 * The three stage timeouts are always set, and `dnsTimeout` reuses
 * `SMTP_CONNECTION_TIMEOUT_MS`; none bounds a send as a whole.
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
    dnsTimeout: env.SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: env.SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: env.SMTP_SOCKET_TIMEOUT_MS,
    ...(env.SMTP_USERNAME !== undefined &&
      env.SMTP_PASSWORD !== undefined && {
        auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
      }),
  }
}

/**
 * The process's nodemailer transporter, created on first call so importing
 * this module never resolves the SMTP settings.
 *
 * `MAIL_FROM` is the transporter's message default, so no caller can
 * override the sender. `requireTLS` is on outside `APP_ENV=local`
 * (`requiresSmtpTls`), keyed on APP_ENV rather than SMTP_HOST because compose
 * can reach Mailpit by another name; it sits on the literal, not behind a
 * spread, because `sonarjs/no-clear-text-protocols` cannot see through a
 * spread call. The return type is annotated because `ReturnType<>` of the
 * overloaded `createTransport` resolves to the `any`-typed catch-all.
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
