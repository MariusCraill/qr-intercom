import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import type { Config } from "../config/index.js";
import { signAccessToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";

export function createApiRouter(db: Database.Database, config: Config): Router {
  const router = Router();

  // ── Public: Get a resident's directory info (shown to a visitor) ───
  router.get("/residents/:residentId/directory", (req: Request, res: Response) => {
    const resident = db
      .prepare("SELECT id, unit, name FROM residents WHERE id = ?")
      .get(req.params.residentId) as any;
    if (!resident) {
      res.status(404).json({ error: "Resident not found" });
      return;
    }
    res.json({ resident });
  });

  // ── Public: Visitor requests a temporary session token ────────────
  router.post("/residents/:residentId/visitor-session", (req: Request, res: Response) => {
    const resident = db
      .prepare("SELECT id FROM residents WHERE id = ?")
      .get(req.params.residentId) as any;
    if (!resident) {
      res.status(404).json({ error: "Resident not found" });
      return;
    }
    const sessionId = uuid();
    const token = signAccessToken(config, {
      sub: sessionId,
      role: "resident", // visitors carry a short-lived resident-scoped token (informational)
      residentId: resident.id,
    });
    res.json({ sessionId, token, residentId: resident.id });
  });

  // ── Auth: Resident login ──────────────────────────────────────────
  router.post("/auth/resident-login", async (req: Request, res: Response) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
      res.status(400).json({ error: "Phone and password required" });
      return;
    }
    const resident = db
      .prepare("SELECT * FROM residents WHERE phone = ?")
      .get(phone) as any;
    if (!resident) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const valid = bcrypt.compareSync(password, resident.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = signAccessToken(config, {
      sub: resident.id,
      role: "resident",
      residentId: resident.id,
      email: resident.email,
    });
    res.json({
      token,
      resident: {
        id: resident.id,
        name: resident.name,
        unit: resident.unit,
        phone: resident.phone,
      },
    });
  });

  // ── Auth: Resident self-registration ─────────────────────────────
  router.post("/auth/resident-register", async (req: Request, res: Response) => {
    const { unit, name, phone, password, email } = req.body;
    if (!unit || !name || !phone || !password) {
      res.status(400).json({ error: "unit, name, phone, password required" });
      return;
    }
    const existing = db.prepare("SELECT id FROM residents WHERE phone = ?").get(phone);
    if (existing) {
      res.status(409).json({ error: "Phone number already registered" });
      return;
    }
    if (email) {
      const dupEmail = db.prepare("SELECT id FROM residents WHERE email = ?").get(email);
      if (dupEmail) {
        res.status(409).json({ error: "Email already in use" });
        return;
      }
    }
    const id = uuid();
    const password_hash = bcrypt.hashSync(password, 10);
    db.prepare(
      "INSERT INTO residents (id, unit, name, phone, password_hash, email) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, unit, name, phone, password_hash, email || null);
    const token = signAccessToken(config, {
      sub: id,
      role: "resident",
      residentId: id,
      email: email || null,
    });
    res.json({
      token,
      resident: {
        id,
        name,
        unit,
        phone,
      },
    });
  });

  // ── Auth: Resident registers push subscription ────────────────────
  router.post(
    "/residents/:residentId/push-subscription",
    requireAuth(config),
    (req: Request, res: Response) => {
      const { residentId } = req.params;
      if (req.auth?.sub !== residentId && req.auth?.role !== "admin") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const { endpoint, keys } = req.body;
      db.prepare(
        "UPDATE residents SET push_endpoint = ?, push_keys = ? WHERE id = ?"
      ).run(endpoint, JSON.stringify(keys), residentId);
      res.json({ ok: true });
    }
  );

  // ── Auth: Resident unlocks (generic, no gate hardware) ────────────
  router.post(
    "/residents/me/unlock",
    requireAuth(config),
    (req: Request, res: Response) => {
      if (req.auth?.role !== "resident") {
        res.status(403).json({ error: "Only residents can unlock" });
        return;
      }
      const residentId = req.auth.residentId || req.auth.sub;
      const { callId } = req.body;
      if (callId) {
        db.prepare(
          "UPDATE call_logs SET unlocked = 1 WHERE id = ? AND resident_id = ?"
        ).run(callId, residentId);
      } else {
        const id = uuid();
        db.prepare(
          "INSERT INTO call_logs (id, resident_id, accepted, unlocked) VALUES (?, ?, 1, 1)"
        ).run(id, residentId);
      }
      res.json({ ok: true, message: "Unlocked" });
    }
  );

  // ── Auth: Get resident's own call logs ────────────────────────────
  router.get(
    "/residents/me/call-logs",
    requireAuth(config),
    (req: Request, res: Response) => {
      if (req.auth?.role !== "resident") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const residentId = req.auth.residentId || req.auth.sub;
      const limit = parseInt(req.query.limit as string) || 50;
      const logs = db
        .prepare(
          `SELECT id, visitor_session_id, started_at, ended_at, accepted, unlocked
           FROM call_logs
           WHERE resident_id = ?
           ORDER BY started_at DESC
           LIMIT ?`
        )
        .all(residentId, limit);
      res.json({ logs });
    }
  );

  // ── Resident: Get own profile ──────────────────────────────────
  router.get(
    "/residents/me",
    requireAuth(config),
    (req: Request, res: Response) => {
      if (req.auth?.role !== "resident") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const resident = db
        .prepare("SELECT id, unit, name, email, phone FROM residents WHERE id = ?")
        .get(req.auth.sub) as any;
      if (!resident) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ resident });
    }
  );

  // ── Resident: Update own profile ───────────────────────────────
  router.put(
    "/residents/me",
    requireAuth(config),
    (req: Request, res: Response) => {
      if (req.auth?.role !== "resident") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const { name, email, phone, password } = req.body;
      const id = req.auth.sub;

      if (!name || !phone) {
        res.status(400).json({ error: "name and phone required" });
        return;
      }

      if (phone) {
        const dup = db.prepare("SELECT id FROM residents WHERE phone = ? AND id != ?").get(phone, id);
        if (dup) { res.status(409).json({ error: "Phone number already in use" }); return; }
      }

      if (email) {
        const dup = db.prepare("SELECT id FROM residents WHERE email = ? AND id != ?").get(email, id);
        if (dup) { res.status(409).json({ error: "Email already in use" }); return; }
      }

      if (password) {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("UPDATE residents SET name=?, phone=?, email=?, password_hash=? WHERE id=?")
          .run(name, phone, email || null, hash, id);
      } else {
        db.prepare("UPDATE residents SET name=?, phone=?, email=? WHERE id=?")
          .run(name, phone, email || null, id);
      }
      res.json({ ok: true });
    }
  );

  // ── Health check ──────────────────────────────────────────────────
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN ROUTES
  // ══════════════════════════════════════════════════════════════════

  const requireAdmin = requireAuth(config);

  function assertAdmin(req: Request, res: Response): boolean {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return false;
    }
    return true;
  }

  // ── Admin login ─────────────────────────────────────────────────
  router.post("/admin/login", (req: Request, res: Response) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }
    const admin = db
      .prepare("SELECT * FROM admins WHERE email = ?")
      .get(email) as any;
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = signAccessToken(config, {
      sub: admin.id,
      role: "admin",
    });
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  });

  // ── List residents ─────────────────────────────────────────────
  router.get("/admin/residents", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const residents = db
      .prepare("SELECT id, unit, name, email, phone, created_at FROM residents ORDER BY unit")
      .all();
    res.json({ residents });
  });

  // ── Create resident ─────────────────────────────────────────────
  router.post("/admin/residents", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const { unit, name, email, password, phone } = req.body;
    if (!unit || !name || !phone || !password) {
      res.status(400).json({ error: "unit, name, phone, password required" });
      return;
    }
    const existing = db.prepare("SELECT id FROM residents WHERE phone = ?").get(phone);
    if (existing) {
      res.status(409).json({ error: "Phone number already exists" });
      return;
    }
    if (email) {
      const dupEmail = db.prepare("SELECT id FROM residents WHERE email = ?").get(email);
      if (dupEmail) {
        res.status(409).json({ error: "Email already exists" });
        return;
      }
    }
    const id = uuid();
    const password_hash = bcrypt.hashSync(password, 10);
    db.prepare(
      "INSERT INTO residents (id, unit, name, phone, password_hash, email) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, unit, name, phone, password_hash, email || null);
    res.json({ id, unit, name, phone, email });
  });

  // ── Update resident ─────────────────────────────────────────────
  router.put("/admin/residents/:id", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const { unit, name, email, password, phone } = req.body;
    const { id } = req.params;
    const existing = db.prepare("SELECT id FROM residents WHERE id = ?").get(id) as any;
    if (!existing) { res.status(404).json({ error: "Resident not found" }); return; }

    if (phone) {
      const dup = db.prepare("SELECT id FROM residents WHERE phone = ? AND id != ?").get(phone, id);
      if (dup) { res.status(409).json({ error: "Phone number already exists" }); return; }
    }

    if (email) {
      const dup = db.prepare("SELECT id FROM residents WHERE email = ? AND id != ?").get(email, id);
      if (dup) { res.status(409).json({ error: "Email already exists" }); return; }
    }

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare("UPDATE residents SET unit=?, name=?, phone=?, email=?, password_hash=? WHERE id=?")
        .run(unit, name, phone, email || null, hash, id);
    } else {
      db.prepare("UPDATE residents SET unit=?, name=?, phone=?, email=? WHERE id=?")
        .run(unit, name, phone, email || null, id);
    }
    res.json({ ok: true });
  });

  // ── Delete resident ─────────────────────────────────────────────
  router.delete("/admin/residents/:id", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    db.prepare("DELETE FROM residents WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // ── List admins ─────────────────────────────────────────────────
  router.get("/admin/admins", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const admins = db.prepare("SELECT id, name, email, created_at FROM admins ORDER BY name").all();
    res.json({ admins });
  });

  // ── Create admin ────────────────────────────────────────────────
  router.post("/admin/admins", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email, password required" }); return;
    }
    const existing = db.prepare("SELECT id FROM admins WHERE email = ?").get(email);
    if (existing) { res.status(409).json({ error: "Email already exists" }); return; }
    const id = uuid();
    const password_hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO admins (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
      .run(id, name, email, password_hash);
    res.json({ id, name, email });
  });

  // ── Delete admin ────────────────────────────────────────────────
  router.delete("/admin/admins/:id", requireAdmin, (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    db.prepare("DELETE FROM admins WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}