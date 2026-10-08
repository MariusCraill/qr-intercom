/**
 * Offline password recovery, for when nobody can reach the web portal.
 *
 * If every admin password is lost, this is the way back in: it writes a new
 * hash directly to the database, so it does not need the server to be running
 * or reachable. It does need exclusive access to the database file, because
 * better-sqlite3 writes are not visible to an already-open connection - run it
 * with the server stopped, or the change appears to vanish.
 *
 * Usage:
 *   npx tsx src/scripts/reset-password.ts --who <email|phone> --password <new>
 *   npx tsx src/scripts/reset-password.ts --list
 *
 * The new password goes through the same policy the API enforces, so this
 * cannot be used to set something the web UI would have refused.
 */
import { loadConfig } from "../config/index.js";
import { initializeDatabase } from "../db/schema.js";
import { validatePassword } from "../auth/validate.js";
import { phoneCandidates, isPhoneLike } from "../auth/phone.js";
import bcrypt from "bcryptjs";

const argv = process.argv.slice(2);
/** Value of --name, or undefined if absent. A valueless flag returns the next
 *  argument, which is why --list is tested with argv.includes instead. */
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);

const config = loadConfig();
const db = initializeDatabase(config.databasePath);

function listAccounts(): void {
  const residents = db
    .prepare("SELECT id, unit, name, phone, email FROM residents ORDER BY unit")
    .all() as any[];
  const admins = db
    .prepare("SELECT id, name, email, phone FROM admins ORDER BY name")
    .all() as any[];

  console.log(`\nResidents (${residents.length}):`);
  for (const r of residents) {
    console.log(
      `  ${r.unit.padEnd(12)} ${String(r.name).padEnd(20)} ${String(r.phone).padEnd(18)} ${r.email || "(no email)"}`,
    );
  }
  console.log(`\nAdmins (${admins.length}):`);
  for (const a of admins) {
    console.log(
      `  ${String(a.name).padEnd(20)} ${String(a.email).padEnd(28)} ${a.phone || "(no phone)"}`,
    );
  }
  console.log("");
}

/** Same resolution the login routes use, so an identifier that signs in works here. */
function findAccount(who: string): { table: "residents" | "admins"; row: any } | undefined {
  if (isPhoneLike(who)) {
    const candidates = phoneCandidates(who);
    for (const table of ["residents", "admins"] as const) {
      const rows = candidates.length
        ? (db
            .prepare(`SELECT * FROM ${table} WHERE phone_norm IN (${candidates.map(() => "?").join(",")})`)
            .all(...candidates) as any[])
        : [];
      if (rows.length === 1) return { table, row: rows[0] };
      if (rows.length > 1) {
        console.error(
          `[Reset] "${who}" matches ${rows.length} accounts in ${table}. Name one by email instead.`,
        );
        process.exit(1);
      }
    }
  }
  for (const table of ["residents", "admins"] as const) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE lower(email) = lower(?)`).get(who) as any;
    if (row) return { table, row };
  }
  return undefined;
}

if (hasFlag("list")) {
  listAccounts();
} else {
  const who = flag("who");
  const password = flag("password");

  if (!who || !password) {
    console.error("Usage: reset-password --who <email|phone> --password <new>");
    console.error("       reset-password --list");
    process.exit(1);
  }

  const pwError = validatePassword(password);
  if (pwError) {
    console.error(`[Reset] Refusing: ${pwError}`);
    process.exit(1);
  }

  const found = findAccount(who);
  if (!found) {
    console.error(`[Reset] No account matches "${who}". Try --list to see what exists.`);
    process.exit(1);
  }

  db.prepare(`UPDATE ${found.table} SET password_hash = ? WHERE id = ?`).run(
    bcrypt.hashSync(password, 10),
    found.row.id,
  );

  console.log(
    `[Reset] Password updated for ${found.row.name} (${found.table}). ` +
      "Sign in with your phone number or email.",
  );
}

db.close();