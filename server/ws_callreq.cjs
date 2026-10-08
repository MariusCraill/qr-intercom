const WebSocket = require("ws");

const WS_URL = "wss://192.168.101.245:3000/ws";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";

const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "register", payload: "visitor", gateId: GATE_ID }));
  setTimeout(() => {
    log("sending call-request to resident ce18c81e...");
    ws.send(JSON.stringify({
      type: "call-request",
      residentId: "ce18c81e-d811-4307-898e-88396705c0c9",
      gateId: GATE_ID,
      payload: { visitorSessionId: "probe" },
    }));
  }, 800);
});

ws.on("message", (data) => {
  const s = data.toString();
  log("RECV:", s.length > 180 ? s.slice(0, 180) : s);
});

ws.on("error", (e) => log("ERR:", e.message));
ws.on("close", (c) => log("closed:", c));

setTimeout(() => { log("--- done ---"); process.exit(0); }, 8000);