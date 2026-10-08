const WebSocket = require("ws");
const WS_URL = "wss://192.168.101.245:3000/ws";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";
const RESIDENT_SESSION = "421dc963-67d8-43d6-b852-9a4576f4e055";
const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "register", payload: "visitor", gateId: GATE_ID }));
  await new Promise((r) => setTimeout(r, 400));
  log("sending call-ended to " + RESIDENT_SESSION);
  ws.send(JSON.stringify({ type: "call-ended", to: RESIDENT_SESSION, payload: { test: true } }));
  await new Promise((r) => setTimeout(r, 3000));
  ws.close();
  process.exit(0);
});
ws.on("message", (d) => log("RECV:", d.toString().slice(0, 140)));
ws.on("error", (e) => log("ERR:", e.message));
setTimeout(() => process.exit(0), 8000);