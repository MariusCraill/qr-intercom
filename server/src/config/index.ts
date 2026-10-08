import fs from "fs";
import path from "path";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Config {
  port: number;
  httpPort: number;
  host: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  databasePath: string;
  turnServers: IceServer[];
  corsOrigins: string[];
  /** Opt in to X-Forwarded-For. Off by default so req.ip cannot be spoofed
   *  to bypass the login rate limiter. Turn on only behind a trusted proxy. */
  trustProxy: boolean;
  /** Lifetime of a password-reset link. */
  resetTokenTtlMin: number;
  /** Where a password-reset link should send the person: origin only, no path.
   *  The resident and admin clients each read ?token= on load. */
  publicBaseUrl: string;
  /** Null when SMTP_HOST is unset, which makes resets print to the console. */
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  } | null;
}

/**
 * Minimal .env loader (no dotenv dependency).
 *
 * Previously this file existed but nothing ever read it: loadConfig() only
 * consulted process.env, so every setting in .env was silently ignored and the
 * server silently ran on the hardcoded fallbacks below. Real environment
 * variables always win, so container/CI overrides keep working.
 */
function loadEnvFile(file = path.resolve(process.cwd(), ".env")): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env is fine - fall back to real env / defaults
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadConfig(): Config {
  loadEnvFile();
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    httpPort: parseInt(process.env.HTTP_PORT || "3010", 10),
    host: process.env.HOST || "0.0.0.0",
    jwtSecret: process.env.JWT_SECRET || "change-me-in-production-use-openssl-rand-base64-32",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    databasePath: process.env.DATABASE_PATH || "./data/intercom.db",
    turnServers: JSON.parse(process.env.TURN_SERVERS || "[]"),
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174,https://desktop-obtdcvt.tail973ab1.ts.net").split(","),
    trustProxy: process.env.TRUST_PROXY === "true",
    resetTokenTtlMin: Math.max(1, parseInt(process.env.RESET_TOKEN_TTL_MIN || "30", 10) || 30),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:3010").replace(/\/+$/, ""),
    smtp: process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587", 10) || 587,
          secure: process.env.SMTP_SECURE === "true",
          user: process.env.SMTP_USER || undefined,
          pass: process.env.SMTP_PASS || undefined,
          from: process.env.SMTP_FROM || process.env.SMTP_USER || "intercom@localhost",
        }
      : null,
  };
}
