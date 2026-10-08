import fs from "fs";
import net from "net";
import path from "path";

/**
 * Where the Vite dev servers should forward /api and /ws.
 *
 * All three client configs used to hardcode `https://localhost:3000`, which is
 * not this server - 3000 is some other project's dev server on this machine.
 * Every request a client made therefore went nowhere useful and came back as
 * 502/500 with an empty body, which the browser clients reported as
 * "Unexpected end of JSON input": a failure that looks exactly like the
 * intercom being switched off.
 *
 * Reading the ports out of server/.env means the clients follow the server
 * instead of holding a copy of its port number that silently rots.
 */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const value = trimmed.slice(eq + 1).trim();
    out[trimmed.slice(0, eq).trim()] =
      value.startsWith('"') || value.startsWith("'")
        ? value.slice(1, -1)
        : value;
  }
  return out;
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function backendProxy(projectRoot: string) {
  const envFile = path.resolve(projectRoot, "server/.env");
  const env = readEnvFile(envFile);
  const port = Number(env.PORT) || 3011;

  if (!Object.prototype.hasOwnProperty.call(env, "PORT")) {
    console.warn(
      `[proxy] Could not read ${envFile}; assuming the server is on :${port}. ` +
        "Set PORT in server/.env if it is not.",
    );
  }

  probe(port).then((up) => {
    if (up) return;
    console.warn(
      `\n[proxy] Nothing is listening on https://127.0.0.1:${port}, so /api and /ws ` +
        "requests from this dev server will fail with an empty body.\n" +
        "        Start the intercom server first:  cd server && npm run dev\n",
    );
  });

  return {
    "/api": {
      target: `https://127.0.0.1:${port}`,
      secure: false, // the LAN cert is self-signed
      changeOrigin: true,
    },
    "/ws": {
      target: `wss://127.0.0.1:${port}`,
      ws: true,
      secure: false,
      changeOrigin: true,
    },
  };
}