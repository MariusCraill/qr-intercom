/**
 * Outbound email for password resets.
 *
 * nodemailer is an optional lazy require rather than a declared dependency:
 * the CI job runs `npm ci`, so adding a package without regenerating
 * package-lock.json breaks the build, and a self-hosted intercom box should
 * not have to install a mail stack it will never use.
 *
 * With SMTP_HOST unset the reset link is printed to the server console
 * instead, which is what makes the flow testable on a LAN install with no mail
 * infrastructure at all.
 */
import { createRequire } from "node:module";
import type { Config } from "./config/index.js";

const require = createRequire(import.meta.url);

let cached: unknown;

function loadNodemailer(): any | null {
  if (cached !== undefined) return cached;
  try {
    cached = require("nodemailer");
  } catch {
    cached = null;
    console.warn(
      "[MAIL] nodemailer is not installed, so reset links go to this console " +
        "instead of email. Set SMTP_HOST and run `npm install nodemailer` to " +
        "deliver them properly.",
    );
  }
  return cached;
}

export interface PasswordResetMail {
  to: string;
  name: string;
  link: string;
  ttlMinutes: number;
}

/**
 * Delivers a reset link. Never throws: a reset that cannot be emailed must not
 * turn into a 500 that tells an unauthenticated caller something is wrong.
 * The token is logged either way, so an operator can always complete the flow.
 */
export async function sendPasswordReset(config: Config, mail: PasswordResetMail): Promise<"smtp" | "console"> {
  const smtp = config.smtp;
  if (!smtp) {
    console.warn(
      "\n[MAIL] SMTP is not configured - password reset link for " +
        `${mail.to} (${mail.name}), valid ${mail.ttlMinutes} minutes:\n` +
        `        ${mail.link}\n`,
    );
    return "console";
  }

  const nodemailer = loadNodemailer();
  if (!nodemailer) {
    console.warn(
      `\n[MAIL] SMTP_HOST is set but nodemailer is not installed - reset link for ` +
        `${mail.to} (${mail.name}), valid ${mail.ttlMinutes} minutes:\n` +
        `        ${mail.link}\n`,
    );
    return "console";
  }

  try {
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await transport.sendMail({
      from: smtp.from,
      to: mail.to,
      subject: "Reset your intercom password",
      text:
        `Hello ${mail.name},\n\n` +
        `Use this link to choose a new password. It works once and expires in ` +
        `${mail.ttlMinutes} minutes.\n\n${mail.link}\n\n` +
        `If you did not ask for this, ignore it - nothing has changed.\n`,
    });
    return "smtp";
  } catch (err) {
    console.error(`[MAIL] Failed to send reset link to ${mail.to}:`, err);
    console.warn(`        Reset link was: ${mail.link}`);
    return "console";
  }
}