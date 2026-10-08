const { execSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");

const ADB = "C:\\Users\\DELL\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "RFCR60R0Z7N";
const LOGDIR = "C:\\Users\\DELL\\AppData\\Local\\Temp\\opencode";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const GATE_ID = "9d5d0d92-4738-4f6f-9ead-be3fa4798ccd";
const RESIDENT_ID = "ce18c81e-d811-4307-898e-88396705c0c9";
const PAGE_URL = `https://192.168.101.245:5173/gate/${GATE_ID}?call=${RESIDENT_ID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const adb = (args) => execSync(`"${ADB}" -s ${SERIAL} ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

function getTargets() {
  return new Promise((res, rej) => {
    http.get("http://127.0.0.1:9222/json", (r) => {
      let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

// Resilient CDP attachment: never hangs, tolerates page reload / crashing renderer,
// re-attaches to the /gate target automatically and keeps a shared console buffer.
function createCdp() {
  let ws = null;
  let dead = false;
  let idn = 0;
  const pending = new Map();
  const consoleMsg = [];
  const state = { connected: 0, lost: 0 };

  function open(target) {
    return new Promise((res) => {
      if (ws) { try { ws.close(); } catch (e) {} }
      ws = new WebSocket(target.webSocketDebuggerUrl);
      dead = false;
      state.connected++;
      ws.on("open", () => {
        setup();
        for (const m of ["Runtime.enable", "Log.enable", "Page.enable"]) {
          try { ws.send(JSON.stringify({ id: ++idn, method: m, params: {} })); } catch (e) {}
        }
        res(true);
      });
      ws.on("error", () => { dead = true; for (const p of pending.values()) p({ _dead: true }); pending.clear(); state.lost++; });
      ws.on("close", () => { dead = true; for (const p of pending.values()) p({ _dead: true }); pending.clear(); state.lost++; });
    });
  }

  function setup() {
    ws.on("message", (d) => {
        if (dead) return;
        let msg;
        try { msg = JSON.parse(d.toString()); } catch (e) { return; }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
          return;
        }
      if (msg.method === "Runtime.consoleAPICalled") {
        const arg = msg.params?.args?.[0]?.value;
        if (typeof arg === "string" && arg.length < 240) consoleMsg.push(`[console] ${arg}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        const desc = d?.exception?.description || d?.text || "exception";
        consoleMsg.push(`[EXCEPTION] ${desc.split("\n").slice(0, 4).join(" ")}`);
      } else if (msg.method === "Log.entryAdded") {
        const t = msg.params?.entry?.text || "";
        consoleMsg.push(`[Log] ${t.slice(0, 200)}`);
      } else if (msg.method === "Runtime.executionContextsCleared") {
        consoleMsg.push("[PAGE] execution contexts cleared — reload/navigation!");
      } else if (msg.method === "Target.targetCrashed") {
        consoleMsg.push("[PAGE] TARGET CRASHED!");
      }
    });
  }

  function attach(target) {
    return open(target).then(() => true);
  }

  return new Promise((res) => {
    const methods = {
      attach,
      evalJS: (expression) => new Promise((resolve) => {
        if (dead || !ws || ws.readyState !== WebSocket.OPEN) { resolve(undefined); return; }
        const id = ++idn;
        pending.set(id, (m) => { if (m._dead) resolve(undefined); else resolve(m.result?.result?.value); });
        try { ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); }
        catch (e) { resolve(undefined); }
      }),
      consoleMsg, state,
      get live() { return !dead && ws && ws.readyState === WebSocket.OPEN; },
      close: () => { try { ws && ws.close(); } catch (e) {} },
    };
    res(methods);
  });
}

async function findPageTarget(maxWait) {
  const until = Date.now() + maxWait;
  while (Date.now() < until) {
    try {
      const list = await getTargets();
      const page = list.find((t) => t.type === "page" && t.url.includes("/gate/"));
      if (page) return page;
    } catch (e) {}
    await sleep(500);
  }
  return null;
}

(async () => {
  try { adb("shell svc power stayon true"); } catch (e) {}
  try { adb("shell input keyevent 224"); } catch (e) {}
  try { adb("shell wm dismiss-keyguard"); } catch (e) {}
  try { adb("shell settings put system screen_off_timeout 1800000"); } catch (e) {}

  // Android 14 silently drops the IncomingCallActivity launch from the background
  // service unless the app has a visible window at call-request time. Bring the
  // app to the foreground FIRST and keep it there until the call is accepted.
  try { adb("shell am start -n com.qrintercom.resident/.LoginActivity"); } catch (e) {}
  await sleep(1200);

  adb("logcat -c");
  const pid = adb("shell pidof com.qrintercom.resident").trim();
  log("app pid =", pid);
  const logFd = fs.openSync(`${LOGDIR}\\audio3_phone.log`, "w");
  const lc = spawn(ADB, ["-s", SERIAL, "logcat", "-v", "time", `--pid=${pid}`], { stdio: ["ignore", "pipe", "pipe"] });
  lc.stdout.on("data", (d) => fs.writeSync(logFd, d));
  lc.stderr.on("data", (d) => fs.writeSync(logFd, Buffer.from("[ERR] " + d)));

  const phoneLog = () => { try { return fs.readFileSync(`${LOGDIR}\\audio3_phone.log`, "utf8"); } catch (e) { return ""; } };

  let tapped = false;
  const foreground = () => {
    // keep the app window visible so the incoming-call activity can start
    if (tapped) return;
    try { adb("shell am start -n com.qrintercom.resident/.LoginActivity"); } catch (e) {}
  };
  foreground();
  const keepalive = setInterval(() => { try { foreground(); } catch (e) {} }, 3000);

  const acceptor = setInterval(() => {
    try {
      if (!tapped && phoneLog().includes("Incoming call from")) {
        tapped = true;
        log("PHONE> Incoming call detected, tapping Accept");
        clearInterval(keepalive);
        try {
          adb("shell uiautomator dump /sdcard/ui.xml");
          const xml = adb("shell cat /sdcard/ui.xml");
          const m = xml.match(/resource-id="com\.qrintercom\.resident:id\/btnAccept"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (m) adb(`shell input tap ${Math.round((+m[1] + +m[3]) / 2)} ${Math.round((+m[2] + +m[4]) / 2)}`);
          else adb("shell input tap 359 1254");
        } catch (e) { try { adb("shell input tap 359 1254"); } catch (_) {} }
        clearInterval(acceptor);
      }
    } catch (e) {}
  }, 500);

  const bfd = fs.openSync(`${LOGDIR}\\visitor_chrome3.log`, "w");
  log("launching Chrome visitor:", PAGE_URL);
  const browser = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--ignore-certificate-errors",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio=false",
    "--no-first-run", "--disable-default-apps", "--no-default-browser-check",
    "--enable-logging=stderr", "--v=0",
    "--remote-debugging-port=9222", "--window-size=800,600",
    `--user-data-dir=${LOGDIR}\\visitor-chrome-prof3`,
    PAGE_URL,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.on("data", (d) => fs.writeSync(bfd, d));

  const target = await findPageTarget(20000);
  const cdp = await createCdp();
  const attached = target ? await cdp.attach(target) : false;
  if (attached) log("CDP attached to visitor page");
  else log("CDP attach failed");

  const until = Date.now() + 60000;
  let lastS = null, lastT = null, lastWsCloses = -1, lastEndCalls = -1;
  let lastJsLog = 0;
  while (Date.now() < until) {
    const p = phoneLog();
    let s = null;
    if (cdp.live) {
      try { s = JSON.parse((await cdp.evalJS("JSON.stringify(window.__audioStats || null)")) || "null"); } catch (e) {}
    }
    if (s && (s.sent !== lastS || s.received !== lastT)) {
      log(`VISITOR> mode=${s.mode} sent=${s.sent} received=${s.received} backlog=${s.backlog} audioprocess=${s.audioprocess || 0}`);
      lastS = s.sent; lastT = s.received;
    }
    if (cdp.live) {
      try {
        const d = JSON.parse((await cdp.evalJS("JSON.stringify(window.__diag || null)")) || "null");
        if (d) {
          if (d.wsCloseCount !== lastWsCloses) { lastWsCloses = d.wsCloseCount; log(`VISITOR-DIAG> wsCloseCount=${d.wsCloseCount} reason="${d.wsCloseReason}" wsOpenCount=${d.wsOpenCount}`); }
          if (d.endCallCalls !== lastEndCalls) { lastEndCalls = d.endCallCalls; log(`VISITOR-DIAG> endCall=${d.endCallCalls} reason="${d.endCallReason}"`); }
        }
      } catch (e) {}
    }
    if (cdp.consoleMsg.length) {
      while (cdp.consoleMsg.length) log("VISITOR-JS>", cdp.consoleMsg.shift());
      lastJsLog = Date.now();
    }
    if (!cdp.live) {
      // re-discover the page target; the renderer may have reloaded or crashed.
      try {
        const list = await getTargets();
        const page = list.find((t) => t.type === "page" && t.url.includes("/gate/"));
        if (page) {
          const ok = await cdp.attach(page);
          if (ok) log(`VISITOR> CDP re-attached (reload? attempts=${cdp.state.connected})`);
        } else if (Date.now() - lastJsLog > 10000) {
          log("VISITOR-DIAG> no /gate target visible — renderer down?");
          lastJsLog = Date.now();
        }
      } catch (e) {}
    }
    // success: audio flowing BOTH ways — visitor received app audio,
    const visitorGot = s && s.received >= 30;
    const visitorSent = s && s.sent >= 30;
    const appGotAudio = /RX audio frames=100/.test(p);
    if (visitorGot && visitorSent && appGotAudio) { log("SUCCESS> audio flowing BOTH ways"); break; }
    await sleep(800);
  }
  await sleep(4000);
  while (cdp.consoleMsg.length) log("VISITOR-JS>", cdp.consoleMsg.shift());
  if (cdp.live) {
    try { log("VISITOR final stats:", await cdp.evalJS("JSON.stringify({stats: window.__audioStats || null, diag: window.__diag || null})")); } catch (e) {}
  }

  if (browser.pid) try { execSync(`taskkill /F /T /PID ${browser.pid}`, { stdio: "ignore" }); } catch (e) {}
  try { if (lc.pid) { lc.kill(); } } catch (e) {}
  await sleep(1500);

  console.log("=== PHONE LOG (audio-relevant, full lines) ===");
  const d = phoneLog();
  const seen = new Set();
  for (const l of d.split("\n")) {
    if (!/NativeCall|CallService/.test(l)) continue;
    const line = l.replace(/^[0-9-]+ [0-9:.]+ +[0-9]+ +[0-9]+ +/, "");
    if (/RX binary|RX dispatch|TX audio|RX audio|Audio started|AudioTrack|Call: visitor|Speakerphone|CODEC|encoder|NS enabled|AEC /.test(line)) {
      const key = line.replace(/\d+/g, "#");
      if (seen.has(key)) continue;
      seen.add(key);
      console.log("  P>", line.slice(0, 220));
    }
  }
  try {
    console.log("=== SERVER LOG (tail) ===");
    const s = fs.readFileSync(`${LOGDIR}\\server.log`, "utf8").split("\n").slice(-12);
    for (const l of s) console.log("  S>", l.slice(0, 180).replace(/.*\] /, ""));
  } catch (e) {}
  if (cdp) cdp.close();
  process.exit(0);
})();