import jwt from "jsonwebtoken";
import type { Config } from "../config/index.js";

export interface JwtPayload {
  sub: string;
  role: "resident" | "admin";
  residentId?: string;
  email?: string;
}

export function signAccessToken(
  config: Config,
  payload: JwtPayload
): string {
  const options: jwt.SignOptions = {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyAccessToken(
  config: Config,
  token: string
): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
