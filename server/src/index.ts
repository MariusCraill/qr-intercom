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

// â”€â”€ Database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const db = initializeDatabase(config.databasePath);
console.log(`[DB] Initialized at ${config.databasePath}`);

// â”€â”€ WebRTC Signaling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const listenServers: NetServer[] = [httpServer];
if (server) listenServers.push(server);
const signaling = new SignalingServer(...listenServers);
console.log(`[WS] Signaling server attached to /ws (${server ? "HTTPS + " : ""}HTTP backend)`);

// â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");

// Baseline hardening. The clients are same-origin bundles served by this
// server, so the policy can be strict; 'unsafe-inline' for styles is needed
// by the Vite output and websocket: is required for the /ws signaling socket.
app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(self), microphone=(self)");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  next();
});

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: "256kb" }));

// â”€â”€ REST API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use("/api", createApiRouter(db, config));

// â”€â”€ Root landing: serve the resident portal so the funnel URL works â”€â”€
app.get("/", (_req, res) => res.redirect("/resident"));

// â”€â”€ Serve static builds if present â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Catch-all for SPA routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Error handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Must be registered after every route. Without this, Express's default
// handler returns the full stack trace to the client, which leaks absolute
// filesystem paths and the fact that a table/column is missing.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[ERROR]", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  },
);

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘         QR Intercom Server v1.0.0                    â•‘
â•‘                                                      â•‘
â•‘  HTTPS/WSS: https://${config.host}:${config.port}             â•‘
â•‘  HTTP:      http://${config.host}:${config.httpPort} (funnel backend)   â•‘
â•‘  DB:       ${config.databasePath.padEnd(36)}â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â”€â”€ Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Last-resort crash guards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Async route rejections are handled per-request by ah() in routes/api.ts.
// These catch anything that still escapes - a stray promise, a throw outside
// the request cycle. An unhandled rejection in either takes the whole process
// down, and since the funnel has no second backend, that means every
// resident's intercom goes offline until someone notices.
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaught exception:", err);
  // The process state is no longer trustworthy, so hand over to the
  // Scheduled Task, which is configured to restart this up to 3 times.
  closeAll();
});
