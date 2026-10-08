import jwt from "jsonwebtoken";
import type { Config } from "../config/index.js";

export interface JwtPayload {
  sub: string;
  role: "resident" | "admin" | "visitor";
  residentId?: string;
  email?: string;
}

export function signAccessToken(
  config: Config,
  payload: JwtPayload,
  expiresIn?: jwt.SignOptions["expiresIn"],
): string {
  const options: jwt.SignOptions = {
    expiresIn: (expiresIn ?? config.jwtExpiresIn) as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyAccessToken(
  config: Config,
  token: string
): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
