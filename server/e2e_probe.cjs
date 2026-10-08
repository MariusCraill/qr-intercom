const { execSync, spawn } = require("child_process");
const fs = require("fs");

const ADB = "C:\\Users\\DELL\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "RFCR60R0Z7N";
const LOGDIR = "C:\\Users\\DELL\\AppData\\Local\\Temp\\opencode";
const WS_URL = "wss://192.168.101.245:3000/ws";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";
const RESIDENT_ID = "ce18c81e-d811-4307-898e-88396705c0c9";

const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const adb = (args) => execSync(`"${ADB}" -s ${SERIAL} ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

(async () => {
  adb("logcat -c");
  const logFd = fs.openSync(`${LOGDIR}\\probe_phone.log`, "w");
  const lc = spawn(ADB, ["-s", SERIAL, "logcat", "-v", "time", "--pid=4718"], { stdio: ["ignore", "pipe", "pipe"] });
  lc.stdout.on("data", (d) => fs.writeSync(logFd, d));
  log("logcat capture started");

  let acceptor = null;
  const spinUpAcceptor = () => {
    if (acceptor) return;
    acceptor = setInterval(() => {
      try {
        const d = fs.readFileSync(`${LOGDIR}\\probe_phone.log`, "utf8");
        if (d.includes("Incoming call from")) {
          log("PHONE> IncomingCallActivity detected, tapping Accept");
          try {
            adb("shell uiautomator dump /sdcard/ui.xml");
            const xml = adb("shell cat /sdcard/ui.xml");
            const m = xml.match(/resource-id="com\.qrintercom\.resident:id\/btnAccept"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (m) {
              const cx = Math.round((+m[1] + +m[3]) / 2);
              const cy = Math.round((+m[2] + +m[4]) / 2);
              log(`PHONE> tapping Accept at ${cx},${cy}`);
              adb(`shell input tap ${cx} ${cy}`);
            } else {
              log("PHONE> btnAccept not found, guessing");
              adb("shell input tap 430 1450");
            }
          } catch (e) { adb("shell input tap 430 1450"); }
          clearInterval(acceptor);
          acceptor = null;
        }
      } catch (e) {}
    }, 1500);
  };
  spinUpAcceptor();

  const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
  const seen = [];
  ws.on("open", async () => {
    log("ws open");
    ws.send(JSON.stringify({ type: "register", payload: "visitor", gateId: GATE_ID }));
    await sleep(500);
    log("sending call-request -> resident " + RESIDENT_ID);
    ws.send(JSON.stringify({ type: "call-request", residentId: RESIDENT_ID, gateId: GATE_ID, payload: { visitorSessionId: "probe-v" } }));
  });

  ws.on("message", (data) => {
    const s = data.toString();
    seen.push(s);
    log("RECV:", s.length > 150 ? s.slice(0, 150) : s);
  });
  ws.on("error", (e) => log("ERR:", e.message));

  // After receiving call-accepted, send a real offer
  const deadlineSend = setInterval(() => {
    const ca = seen.find((x) => x.includes('"call-accepted"'));
    if (ca) {
      clearInterval(deadlineSend);
      log("★ got call-accepted, sending OFFER");
      ws.send(JSON.stringify({
        type: "offer",
        to: "9d317ac3-88be-4e3e-b00d-c625852a136b",
        payload: {
          type: "offer",
          sdp: "v=0\r\no=probe 2890844526 2890844527 IN IP4 127.0.0.1\r\ns=probe-session\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\na=ice-ufrag:aaaaaaaa\r\na=ice-pwd:bbbbbbbbbbbbbbbbbbbb\r\nm=audio 49170 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n",
        },
      }));
      setTimeout(() => {
        log("--- done, dumping phone tail ---");
        const d = fs.readFileSync(`${LOGDIR}\\probe_phone.log`, "utf8");
        const tail = d.split("\n").filter((l) => l.trim()).slice(-80);
        for (const l of tail) log("  P>", l.slice(0, 200));
        process.exit(0);
      }, 8000);
    }
  }, 500);

  setTimeout(() => { log("--- timeout ---"); process.exit(0); }, 60000);
})();