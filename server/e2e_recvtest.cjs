const { execSync, spawn } = require("child_process");
const fs = require("fs");

const ADB = "C:\\Users\\DELL\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "RFCR60R0Z7N";
const LOGDIR = "C:\\Users\\DELL\\AppData\\Local\\Temp\\opencode";
const WS_URL = "wss://192.168.101.245:3000/ws";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";
const RESIDENT_ID = "ce18c81e-d811-4307-898e-88396705c0c9";
const RESIDENT_SESSION = process.env.RESIDENT_SESSION || "939a1af6-76e3-4f4e-b9ee-cfd3d9313e52";

const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const adb = (args) => execSync(`"${ADB}" -s ${SERIAL} ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

(async () => {
  // keep the phone awake and foreground-visible for the whole test
  try { adb("shell svc power stayon true"); } catch (e) {}
  try { adb("shell input keyevent 224"); } catch (e) {}
  try { adb("shell wm dismiss-keyguard"); } catch (e) {}
  try { adb("shell settings put system screen_off_timeout 1800000"); } catch (e) {}

  adb("logcat -c");
  const pid = adb("shell pidof com.qrintercom.resident").trim();
  log("app pid =", pid);
  const logFd = fs.openSync(`${LOGDIR}\\recv_phone.log`, "w");
  const lc = spawn(ADB, ["-s", SERIAL, "logcat", "-v", "time", `--pid=${pid}`], { stdio: ["ignore", "pipe", "pipe"] });
  lc.stdout.on("data", (d) => fs.writeSync(logFd, d));
  lc.stderr.on("data", (d) => fs.writeSync(logFd, Buffer.from("[ERR] " + d)));
  log("logcat capture started");

  const phoneLogTail = () => {
    try { return fs.readFileSync(`${LOGDIR}\\recv_phone.log`, "utf8"); } catch (e) { return ""; }
  };

  // auto-accept
  let tapped = false;
  const acceptor = setInterval(() => {
    try {
      if (!tapped && phoneLogTail().includes("Incoming call from")) {
        tapped = true;
        log("PHONE> IncomingCallActivity detected, tapping Accept");
        try {
          adb("shell uiautomator dump /sdcard/ui.xml");
          const xml = adb("shell cat /sdcard/ui.xml");
          const m = xml.match(/resource-id="com\.qrintercom\.resident:id\/btnAccept"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (m) adb(`shell input tap ${Math.round((+m[1] + +m[3]) / 2)} ${Math.round((+m[2] + +m[4]) / 2)}`);
          else adb("shell input tap 430 1450");
        } catch (e) { try { adb("shell input tap 430 1450"); } catch (_) {} }
        clearInterval(acceptor);
      }
    } catch (e) {}
  }, 800);

  const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
  let accepted = false;

  ws.on("open", async () => {
    log("ws open");
    ws.send(JSON.stringify({ type: "register", payload: "visitor", gateId: GATE_ID }));
    await sleep(400);
    ws.send(JSON.stringify({ type: "call-request", residentId: RESIDENT_ID, gateId: GATE_ID, payload: { visitorSessionId: "recv-test-2" } }));
  });

  ws.on("message", (data) => {
    const s = data.toString();
    log("RECV:", s.length > 140 ? s.slice(0, 140) : s);
    try {
      const o = JSON.parse(s);
      if (o.type === "call-accepted") accepted = true;
    } catch (e) {}
  });

  ws.on("error", (e) => log("ERR:", e.message));

  // Fixed-timing signal burst, independent of page "Ready" (mic may fail independently).
  const sched = setInterval(() => {
    if (!accepted) return;
    clearInterval(sched);
    log("call accepted. waiting 6s for page load, then sending signals");
    const send = (type, extra) => {
      ws.send(JSON.stringify({ type, to: RESIDENT_SESSION, payload: { test: true, ...extra } }));
      log("sent", type);
    };
    setTimeout(() => {
      log("--- dumping receiver registrations (pre) ---");
      try { adb("shell dumpsys activity broadcasts") } catch (e) {}
      send("offer", { type: "offer", sdp: "test-offer-sdp PROBE2" });
    }, 6000);
    setTimeout(() => send("answer", { type: "answer", sdp: "test-answer-sdp" }), 8500);
    setTimeout(() => send("call-accepted", {}), 11000);
    setTimeout(() => send("ice-candidate", { type: "ice-candidate", candidate: "test-ice-1" }), 13500);
    setTimeout(() => send("call-ended", { reason: "probe-finished" }), 16000);
    setTimeout(() => {
      console.log("=== PHONE LOG (app-relevant) ===");
      const d = phoneLogTail();
      for (const l of d.split("\n")) {
        if (/CallService|WebViewCall|IncomingCall|BroadcastReceiver|Crash|FATAL|AndroidRuntime/.test(l))
          console.log("  P>", l.slice(0, 190));
      }
      process.exit(0);
    }, 22000);
  }, 400);

  setTimeout(() => { log("--- timeout ---"); process.exit(0); }, 55000);
})();