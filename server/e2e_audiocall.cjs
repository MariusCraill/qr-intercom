const { execSync, spawn } = require("child_process");
const fs = require("fs");

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

(async () => {
  try { adb("shell svc power stayon true"); } catch (e) {}
  try { adb("shell input keyevent 224"); } catch (e) {}
  try { adb("shell wm dismiss-keyguard"); } catch (e) {}
  try { adb("shell settings put system screen_off_timeout 1800000"); } catch (e) {}
  try { adb("shell am start -n com.qrintercom.resident/.MainActivity"); } catch (e) {}

  adb("logcat -c");
  const pid = adb("shell pidof com.qrintercom.resident").trim();
  log("app pid =", pid);
  const logFd = fs.openSync(`${LOGDIR}\\audio_phone.log`, "w");
  const lc = spawn(ADB, ["-s", SERIAL, "logcat", "-v", "time", `--pid=${pid}`], { stdio: ["ignore", "pipe", "pipe"] });
  lc.stdout.on("data", (d) => fs.writeSync(logFd, d));
  lc.stderr.on("data", (d) => fs.writeSync(logFd, Buffer.from("[ERR] " + d)));
  log("logcat capture started");

  const phoneLog = () => { try { return fs.readFileSync(`${LOGDIR}\\audio_phone.log`, "utf8"); } catch (e) { return ""; } };

  // auto-accept
  let tapped = false;
  const acceptor = setInterval(() => {
    try {
      if (!tapped && phoneLog().includes("Incoming call from")) {
        tapped = true;
        log("PHONE> Incoming call detected, tapping Accept");
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

  // visitor browser with fake real media
  log("launching Chrome visitor:", PAGE_URL);
  const chromeArgs = [
    "--headless=new",
    "--disable-gpu",
    "--ignore-certificate-errors",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio=false",
    "--no-first-run",
    "--disable-default-apps",
    "--no-default-browser-check",
    "--window-size=800,600",
    `--user-data-dir=${LOGDIR}\\visitor-chrome-profile`,
    PAGE_URL,
  ];
  const bfd = fs.openSync(`${LOGDIR}\\visitor_chrome.log`, "w");
  const browser = spawn(CHROME, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.on("data", (d) => fs.writeSync(bfd, d));
  browser.on("exit", (c) => log("chrome exited code", c));

  const SUCCESS = /Connection state\s*[:=]\s*connected/i;
  const FAIL = /Declined|unavailable|Mic access denied|connectionState.*failed/i;
  const deadlines = { ring: 25000, connect: 60000 };
  const ringAt = Date.now();
  const adminAt = Date.now() + deadlines.ring;
  while (Date.now() < adminAt) {
    const d = phoneLog();
    if (d.includes("Incoming call from") && !tapped) {
      log("PHONE> ringing line seen");
      break;
    }
    await sleep(500);
  }
  if (!tapped) log("WARN> no incoming-call line yet (checking anyway)");

  const connectAt = Date.now() + deadlines.connect;
  let ok = false;
  while (Date.now() < connectAt) {
    const d = phoneLog();
    if (SUCCESS.test(d)) { ok = true; log("SUCCESS> peer connection CONNECTED on phone"); break; }
    if (FAIL.test(d)) { log("FAIL> failure marker on phone"); break; }
    await sleep(700);
  }
  await sleep(6000); // let ICE + remote tracks settle
  log(ok ? "connected ok" : "NOT connected");

  // hang up: close the visitor browser (server sends call-ended)
  if (browser.pid) try { execSync(`taskkill /F /T /PID ${browser.pid}`, { stdio: "ignore" }); } catch (e) {}
  await sleep(4000);

  console.log("=== PHONE LOG (app-relevant) ===");
  const d = phoneLog();
  for (const l of d.split("\n")) {
    if (/CallService|WebViewCall|IncomingCall|Signal|WebRTC|Bridge|Ready|Mic|Remote|Connection/.test(l))
      console.log("  P>", l.replace(/^[0-9-]+ [0-9:.]+ +[0-9]+ +[0-9]+ +/,"").slice(0, 190));
  }
  try {
    console.log("=== SERVER LOG (tail) ===");
    const s = fs.readFileSync(`${LOGDIR}\\server.log`, "utf8").split("\n").slice(-25);
    for (const l of s) console.log("  S>", l.slice(0, 190).replace(/.*\] /,""));
  } catch (e) {}

  process.exit(ok ? 0 : 1);
})();