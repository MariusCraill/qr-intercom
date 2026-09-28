import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type JwtPayload } from "./jwt.js";
import type { Config } from "../config/index.js";

declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

export function requireAuth(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }
    try {
      req.auth = verifyAccessToken(config, header.slice(7));
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

export function optionalAuth(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        req.auth = verifyAccessToken(config, header.slice(7));
      } catch {
        // ignore invalid tokens for optional auth
      }
    }
    next();
  };
}
