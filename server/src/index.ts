import express from "express";
import cors from "cors";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config/index.js";
import { initializeDatabase } from "./db/schema.js";
import { createApiRouter } from "./routes/api.js";
import { SignalingServer } from "./signaling/handler.js";

const config = loadConfig();
const app = express();

const certDir = path.resolve("../certs");
const sslOptions = {
  key: fs.readFileSync(path.join(certDir, "key.pem")),
  cert: fs.readFileSync(path.join(certDir, "cert.pem")),
};
const server = https.createServer(sslOptions, app);

// Plain-HTTP backend used by the Tailscale funnel (which proxies as HTTP).
// Shares the same Express app and the same WebRTC signaling state.
const httpServer = http.createServer(app);

// ── Database ────────────────────────────────────────────────────────
const db = initializeDatabase(config.databasePath);
console.log(`[DB] Initialized at ${config.databasePath}`);

// ── WebRTC Signaling ────────────────────────────────────────────────
const signaling = new SignalingServer(server, httpServer);
console.log("[WS] Signaling server attached to /ws (HTTPS + HTTP backend)");

// ── Middleware ───────────────────────────────────────────────────────
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json());

// ── REST API ────────────────────────────────────────────────────────
app.use("/api", createApiRouter(db, config));

// ── Root landing: serve the resident portal so the funnel URL works ──
app.get("/", (_req, res) => res.redirect("/resident"));

// ── Serve static builds if present ──────────────────────────────────
const visitorDist = path.resolve("../client-visitor/dist");
const residentDist = path.resolve("../client-resident/dist");
const adminDist = path.resolve("../client-admin/dist");

if (fs.existsSync(visitorDist)) {
  app.use("/visit", express.static(visitorDist));
}
if (fs.existsSync(residentDist)) {
  app.use("/resident", express.static(residentDist));
}
if (fs.existsSync(adminDist)) {
  app.use("/admin", express.static(adminDist));
}

// ── Catch-all for SPA routes ────────────────────────────────────────
app.get("/visit/*", (_req, res) => {
  const indexPath = path.join(visitorDist, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Visitor client not built. Run: cd client-visitor && npm run build");
  }
});

app.get("/resident/*", (_req, res) => {
  const indexPath = path.join(residentDist, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Resident client not built. Run: cd client-resident && npm run build");
  }
});

app.get("/admin/*", (_req, res) => {
  const indexPath = path.join(adminDist, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Admin client not built. Run: cd client-admin && npm run build");
  }
});

// ── Start ───────────────────────────────────────────────────────────
server.listen(config.port, config.host, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         QR Intercom Server v1.0.0                    ║
║                                                      ║
║  HTTPS/WSS: https://${config.host}:${config.port}             ║
║  HTTP:      http://${config.host}:${config.httpPort} (funnel backend)   ║
║  DB:       ${config.databasePath.padEnd(36)}║
╚══════════════════════════════════════════════════════╝
  `);
});

httpServer.listen(config.httpPort, config.host, () => {
  console.log(`[HTTP] Funnel backend listening on http://${config.host}:${config.httpPort}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────
const closeAll = () => {
  db.close();
  server.close(() => process.exit(0));
  httpServer.close();
};

process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down...");
  closeAll();
});

process.on("SIGTERM", () => {
  closeAll();
});
