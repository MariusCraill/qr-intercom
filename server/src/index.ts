import express from "express";
import cors from "cors";
import https from "https";
import http from "http";
import type { Server as NetServer } from "net";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config/index.js";
import { initializeDatabase } from "./db/schema.js";
import { createApiRouter } from "./routes/api.js";
import { SignalingServer } from "./signaling/handler.js";

const config = loadConfig();
const app = express();

// TLS material is optional. The Tailscale funnel terminates TLS itself and
// proxies plain HTTP to HTTP_PORT, so a missing/broken cert must not stop the
// funnel backend from coming up.
const certDir = path.resolve("../certs");
const sslOptions = (() => {
  try {
    return {
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    };
  } catch (err) {
    console.warn(
      `[TLS] No certs in ${certDir} - starting HTTP-only. ` +
        `LAN HTTPS on :${config.port} will be unavailable (${(err as Error).message})`,
    );
    return null;
  }
})();
const server = sslOptions ? https.createServer(sslOptions, app) : null;

// Plain-HTTP backend used by the Tailscale funnel (which proxies as HTTP).
// Shares the same Express app and the same WebRTC signaling state.
const httpServer = http.createServer(app);

// ── Database ────────────────────────────────────────────────────────
const db = initializeDatabase(config.databasePath);
console.log(`[DB] Initialized at ${config.databasePath}`);

// ── WebRTC Signaling ────────────────────────────────────────────────
const listenServers: NetServer[] = [httpServer];
if (server) listenServers.push(server);
const signaling = new SignalingServer(...listenServers);
console.log(`[WS] Signaling server attached to /ws (${server ? "HTTPS + " : ""}HTTP backend)`);

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
// A listener that cannot bind must never take the process down: HTTP_PORT is
// the path the phones and browsers actually use, so it has to survive whatever
// happens to the optional LAN HTTPS port.
const onListenError = (label: string, port: number) => (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[${label}] Port ${port} is already in use - ${label} listener disabled. ` +
        `Stop whatever owns it, or set ${label === "HTTP" ? "HTTP_PORT" : "PORT"} to a free port.`,
    );
  } else {
    console.error(`[${label}] Listener failed on port ${port}:`, err);
  }
  if (label === "HTTP") process.exit(1);
};

console.log(`
╔══════════════════════════════════════════════════════╗
║         QR Intercom Server v1.0.0                    ║
║                                                      ║
║  HTTPS/WSS: https://${config.host}:${config.port}             ║
║  HTTP:      http://${config.host}:${config.httpPort} (funnel backend)   ║
║  DB:       ${config.databasePath.padEnd(36)}║
╚══════════════════════════════════════════════════════╝
  `);

if (server) {
  server.on("error", onListenError("HTTPS", config.port));
  server.listen(config.port, config.host, () => {
    console.log(`[HTTPS] Direct LAN access on https://${config.host}:${config.port}`);
  });
}

httpServer.on("error", onListenError("HTTP", config.httpPort));
httpServer.listen(config.httpPort, config.host, () => {
  console.log(`[HTTP] Funnel backend listening on http://${config.host}:${config.httpPort}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────
const closeAll = () => {
  db.close();
  if (server) server.close(() => process.exit(0));
  else httpServer.close(() => process.exit(0));
  httpServer.close();
};

process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down...");
  closeAll();
});

process.on("SIGTERM", () => {
  closeAll();
});
