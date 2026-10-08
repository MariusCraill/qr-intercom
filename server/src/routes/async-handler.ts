import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * pipeline.
 *
 * Express 4 only catches synchronous throws. A rejection inside an async
 * handler escapes it entirely, surfaces as an unhandledRejection, and kills
 * the process - taking the whole funnel down with it. That is not theoretical:
 * a NOT NULL violation in the register route took the process down and put
 * every resident's intercom offline.
 *
 * Usage:  router.post("/thing", requireAuth(config), ah(async (req, res) => { ... }))
 *
 * Express 5 handles this natively; this shim is for the Express 4 dependency.
 */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
