/**
 * Password reset tokens.
 *
 * Only the SHA-256 of a token is stored, so a copy of the database does not
 * hand out working reset links. The token itself is 32 random bytes, generated
 * per request and never logged except through the mailer (or, when SMTP is not
 * configured, the server console).
 *
 * Tokens are single-use and expire. Requesting a new one retires any
 * outstanding token for that account, so an old email that was already sitting
 * in an inbox cannot be replayed after the owner has asked for a fresh link.
 */
import { createHash, randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";

export type AccountType = "resident" | "admin";

export interface ResetTarget {
  type: AccountType;
  id: string;
  name: string;
  email: string | null;
}

export interface ResetFailure {
  ok: false;
  status: number;
  error: string;
}

export type ResetResult = { ok: true } | ResetFailure;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mints a token and records its hash. The caller owns delivery. */
export function createPasswordReset(
  db: Database.Database,
  target: ResetTarget,
  ttlMinutes: number,
): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    "DELETE FROM password_resets WHERE account_type = ? AND account_id = ?",
  ).run(target.type, target.id);
  db.prepare(
    `INSERT INTO password_resets (id, account_type, account_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uuid(), target.type, target.id, hashToken(token), expiresAt);
  return token;
}

/**
 * Validates a token, stores the new password and burns the token.
 *
 * The password write and the "used" mark share one transaction. Without that,
 * two concurrent requests carrying the same token could both set a password and
 * both succeed, which is exactly what single-use is supposed to prevent.
 */
export function consumePasswordReset(
  db: Database.Database,
  token: string,
  newPasswordHash: string,
): ResetResult {
  const row = db
    .prepare("SELECT id, account_type, account_id, used_at, expires_at FROM password_resets WHERE token_hash = ?")
    .get(hashToken(token)) as
    | { id: string; account_type: AccountType; account_id: string; used_at: string | null; expires_at: string }
    | undefined;

  if (!row) return { ok: false, status: 400, error: "This reset link is not valid." };
  if (row.used_at) {
    return { ok: false, status: 400, error: "This reset link has already been used. Request a new one." };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, status: 400, error: "This reset link has expired. Request a new one." };
  }

  const table = row.account_type === "admin" ? "admins" : "residents";
  const apply = db.transaction(() => {
    db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(
      newPasswordHash,
      row.account_id,
    );
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(row.id);
  });
  apply();

  return { ok: true };
}

/** Removes tokens that expired more than a day ago. Cheap housekeeping. */
export function pruneExpiredResets(db: Database.Database): number {
  return db
    .prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')")
    .run().changes;
}