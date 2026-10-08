const WebSocket = require("ws");

const WS_URL = "wss://192.168.101.245:3000/ws";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";
const RESIDENT_SESSION = "9d317ac3-88be-4e3e-b00d-c625852a136b";

const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "register", payload: "visitor", gateId: GATE_ID }));
  setTimeout(() => {
    log("sending offer #1 -> resident session " + RESIDENT_SESSION);
    ws.send(JSON.stringify({
      type: "offer",
      to: RESIDENT_SESSION,
      payload: { sdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=probe1\r\n", type: "offer" },
    }));
  }, 800);
  setTimeout(() => {
    log("sending offer #2 -> resident session " + RESIDENT_SESSION);
    ws.send(JSON.stringify({
      type: "offer",
      to: RESIDENT_SESSION,
      payload: { sdp: "v=0\r\no=- 111 222 IN IP4 127.0.0.1\r\ns=probe2\r\n", type: "offer" },
    }));
  }, 2500);
});

ws.on("message", (data) => {
  const s = data.toString();
  log("RECV:", s.length > 180 ? s.slice(0, 180) : s);
});

ws.on("error", (e) => log("ERR:", e.message));
ws.on("close", (c) => log("closed:", c));

setTimeout(() => { log("--- done ---"); process.exit(0); }, 12000);
