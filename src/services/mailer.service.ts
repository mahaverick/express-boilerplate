import 'dotenv/config';

import { SESClient } from '@aws-sdk/client-ses';
import { fromEnv } from '@aws-sdk/credential-providers';
import { createTransport, Transporter } from 'nodemailer';

import { AWS, CLIENT_URL, ENV, FROM_EMAIL, SMTP_CREDENTIALS } from '@/configs/constants/constants';
import { logger } from '@/utils/logger.utils';

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Mailer class
 *
 * @class Mailer
 */
class Mailer {
  private static instance: Mailer;
  private transporter: Transporter;

  /**
   * Constructor
   *
   * @private
   * @constructor
   */
  constructor() {
    if (ENV === 'production') {
      const ses = new SESClient({
        region: AWS.region,
        credentials: fromEnv(),
      });
      this.transporter = createTransport({
        SES: { ses, aws: { SESClient } },
      });
    } else {
      this.transporter = createTransport({
        host: SMTP_CREDENTIALS.host,
        port: SMTP_CREDENTIALS.port,
        auth: {
          user: SMTP_CREDENTIALS.username,
          pass: SMTP_CREDENTIALS.password,
        },
      });
    }
  }

  /**
   * Get instance
   *
   * @static
   * @returns {Mailer}
   * @memberof Mailer
   */
  public static getInstance(): Mailer {
    if (!Mailer.instance) {
      Mailer.instance = new Mailer();
    }
    return Mailer.instance;
  }

  /**
   * Send email
   *
   * @param {EmailOptions} options - Email options
   * @returns {Promise<void>}
   * @memberof Mailer
   */
  async sendEmail(options: EmailOptions): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: FROM_EMAIL,
        ...options,
      });
      logger.info(`Email sent successfully to ${options.to}`);
    } catch (error) {
      logger.error('Error sending email:', error);
      throw new Error('Failed to send email');
    }
  }

  /**
   * Send verification email
   *
   * @param {string} to - Email address to send the email to
   * @param {string} verificationToken - Verification token
   * @returns {Promise<void>}
   * @memberof Mailer
   */
  async sendVerificationEmail(to: string, verificationToken: string): Promise<void> {
    const verificationLink = `${CLIENT_URL}/email/verify?token=${verificationToken}&email=${to}`;
    const emailOptions: EmailOptions = {
      to,
      subject: 'Verify your email for Boilerplate',
      text: `Please verify your email by clicking this link: ${verificationLink}`,
      html: `
        <html>
          <body>
            <h1>Verify your email</h1>
            <p>Please click the link below to verify your email:</p>
            <a href="${verificationLink}">Verify Email</a>
          </body>
        </html>
      `,
    };
    await this.sendEmail(emailOptions);
  }

  /**
   * Send password reset email
   *
   * @param {string} to - Email address to send the email to
   * @param {string} resetToken - Password reset token
   * @returns {Promise<void>}
   * @memberof Mailer
   */
  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    const resetLink = `${CLIENT_URL}/password/reset?token=${resetToken}&email=${to}`;
    const emailOptions: EmailOptions = {
      to,
      subject: 'Reset your password for Edyt',
      text: `Please reset your password by clicking this link: ${resetLink}`,
      html: `
      <html>
        <body>
          <h1>Reset your password</h1>
          <p>Please click the link below to reset your password:</p>
          <a href="${resetLink}">Reset Password</a>
        </body>
      </html>
    `,
    };
    await this.sendEmail(emailOptions);
  }
}

export const mailer = Mailer.getInstance();
