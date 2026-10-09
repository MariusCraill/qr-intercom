import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import type { Config } from "../config/index.js";
import { requireAuth } from "../auth/middleware.js";
import { ah } from "./async-handler.js";
import {
  authorizeUrl,
  ewelinkConfigFromEnv,
  exchangeCode,
  listDevices,
  refresh,
  switchOn,
  type EwelinkConfig,
  type EwelinkTokens,
} from "../ewelink.js";

/**
 * Lets a resident link their eWeLink account, pick one device, and open the
 * gate with it from the call screen.
 *
 *   GET    /ewelink/status          linked? which device?
 *   GET    /ewelink/authorize-url   eWeLink sign-in page for this resident
 *   GET    /ewelink/callback        eWeLink redirects here after sign-in
 *   GET    /ewelink/devices         devices on the linked account
 *   PUT    /ewelink/device          choose the gate device
 *   DELETE /ewelink                 unlink
 *   POST   /ewelink/open            switch the device on (only during a call)
 */
export function createEwelinkRouter(
  db: Database.Database,
  config: Config,
  isResidentInCall: (residentId: string) => boolean,
): Router {
  const router = Router();
  const auth = requireAuth(config);
  const redirectUrl = `${config.publicBaseUrl}/api/ewelink/callback`;
  // Derived key, so an OAuth state value can never pass as a session token.
  const stateSecret = `${config.jwtSecret}:ewelink-oauth-state`;

  const residentOf = (req: Request, res: Response): string | null => {
    if (req.auth?.role !== "resident") {
      res.status(403).json({ error: "Only residents can use a gate device" });
      return null;
    }
    return req.auth.residentId || req.auth.sub;
  };

  const requireConfig = (res: Response): EwelinkConfig | null => {
    const cfg = ewelinkConfigFromEnv();
    if (!cfg) {
      res.status(503).json({
        error: "eWeLink is not set up on the server yet (EWELINK_APP_ID / EWELINK_APP_SECRET).",
      });
    }
    return cfg;
  };

  const loadTokens = (residentId: string): (EwelinkTokens & { row: any }) | null => {
    const row = db.prepare("SELECT * FROM ewelink_links WHERE resident_id = ?").get(residentId) as any;
    if (!row) return null;
    return {
      row,
      region: row.region,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessExpiresAt: row.access_expires_at,
    };
  };

  const saveTokens = (residentId: string, t: EwelinkTokens): void => {
    db.prepare(
      `INSERT INTO ewelink_links (resident_id, region, access_token, refresh_token, access_expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(resident_id) DO UPDATE SET
         region = excluded.region, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at,
         updated_at = datetime('now')`,
    ).run(residentId, t.region, t.accessToken, t.refreshToken, t.accessExpiresAt);
  };

  /** Runs fn with a fresh access token, refreshing once if eWeLink rejects it. */
  async function withTokens<T>(
    cfg: EwelinkConfig,
    residentId: string,
    fn: (t: EwelinkTokens) => Promise<T>,
  ): Promise<T> {
    let t = loadTokens(residentId);
    if (!t) throw Object.assign(new Error("No eWeLink account linked"), { status: 409 });
    if (t.accessExpiresAt - Date.now() < 24 * 3600 * 1000) {
      t = { ...(await refresh(cfg, t)), row: t.row };
      saveTokens(residentId, t);
    }
    try {
      return await fn(t);
    } catch (err: any) {
      if (err.code !== 401 && err.code !== 402) throw err;
      const fresh = await refresh(cfg, t);
      saveTokens(residentId, fresh);
      return fn(fresh);
    }
  }

  router.get("/ewelink/status", auth, (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    const t = loadTokens(residentId);
    res.json({
      configured: !!ewelinkConfigFromEnv(),
      linked: !!t,
      device: t?.row.device_id
        ? { id: t.row.device_id, name: t.row.device_name, outlet: t.row.device_outlet }
        : null,
    });
  });

  router.get("/ewelink/authorize-url", auth, (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    const cfg = requireConfig(res);
    if (!cfg) return;
    const state = jwt.sign({ sub: residentId }, stateSecret, { audience: "ewelink-oauth", expiresIn: "15m" });
    res.json({ url: authorizeUrl(cfg, redirectUrl, state) });
  });

  // eWeLink's sign-in page redirects the phone's browser here, so this answers
  // with a small page rather than JSON.
  router.get("/ewelink/callback", ah(async (req: Request, res: Response) => {
    const page = (title: string, text: string) =>
      res.type("html").send(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${title}</title><body style="font-family:sans-serif;padding:24px;background:#0f172a;color:#e2e8f0">` +
          `<h2>${title}</h2><p>${text}</p></body>`,
      );
    const cfg = ewelinkConfigFromEnv();
    if (!cfg) return page("eWeLink not set up", "Ask the building admin to finish the eWeLink setup.");

    let residentId: string;
    try {
      const claims = jwt.verify(String(req.query.state || ""), stateSecret, { audience: "ewelink-oauth" }) as any;
      residentId = claims.sub;
    } catch {
      res.status(400);
      return page("Link expired", "Go back to the intercom app and tap Connect eWeLink again.");
    }
    const code = String(req.query.code || "");
    const region = String(req.query.region || "eu");
    if (!code) {
      res.status(400);
      return page("Not connected", "eWeLink did not send a sign-in code. Try again from the app.");
    }
    try {
      const tokens = await exchangeCode(cfg, region, code, redirectUrl);
      saveTokens(residentId, tokens);
    } catch (err: any) {
      console.error("[eWeLink] Token exchange failed:", err.message);
      res.status(502);
      return page("Not connected", "eWeLink refused the sign-in. Try again from the app.");
    }
    return page("eWeLink connected", "Go back to the intercom app and choose your gate device.");
  }));

  router.get("/ewelink/devices", auth, ah(async (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    const cfg = requireConfig(res);
    if (!cfg) return;
    try {
      const devices = await withTokens(cfg, residentId, (t) => listDevices(cfg, t));
      res.json({ devices });
    } catch (err: any) {
      res.status(err.status || 502).json({ error: err.message });
    }
  }));

  router.put("/ewelink/device", auth, (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    const { id, name, outlet } = req.body || {};
    if (typeof id !== "string" || !id || typeof name !== "string") {
      res.status(400).json({ error: "Device id and name required" });
      return;
    }
    const out = outlet === null || outlet === undefined ? null : Number(outlet);
    if (out !== null && !Number.isInteger(out)) {
      res.status(400).json({ error: "Invalid outlet" });
      return;
    }
    const r = db
      .prepare("UPDATE ewelink_links SET device_id = ?, device_name = ?, device_outlet = ?, updated_at = datetime('now') WHERE resident_id = ?")
      .run(id, name.slice(0, 100), out, residentId);
    if (r.changes === 0) {
      res.status(409).json({ error: "No eWeLink account linked" });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/ewelink", auth, (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    db.prepare("DELETE FROM ewelink_links WHERE resident_id = ?").run(residentId);
    res.json({ ok: true });
  });

  router.post("/ewelink/open", auth, ah(async (req: Request, res: Response) => {
    const residentId = residentOf(req, res);
    if (!residentId) return;
    const cfg = requireConfig(res);
    if (!cfg) return;
    // The button is for letting in the visitor you are talking to, so it only
    // works while that call is up. A stolen phone token alone cannot open it.
    if (!isResidentInCall(residentId)) {
      res.status(409).json({ error: "The gate can only be opened during a call" });
      return;
    }
    const link = loadTokens(residentId);
    if (!link?.row.device_id) {
      res.status(409).json({ error: "No gate device chosen" });
      return;
    }
    try {
      await withTokens(cfg, residentId, (t) => switchOn(cfg, t, link.row.device_id, link.row.device_outlet ?? null));
    } catch (err: any) {
      console.error("[eWeLink] Open failed:", err.message);
      res.status(err.status || 502).json({ error: err.message });
      return;
    }
    db.prepare(
      `UPDATE call_logs SET unlocked = 1 WHERE id = (
         SELECT id FROM call_logs WHERE resident_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)`,
    ).run(residentId);
    console.log(`[eWeLink] Gate opened by resident ${residentId} (${link.row.device_name})`);
    res.json({ ok: true, device: link.row.device_name });
  }));

  return router;
}
