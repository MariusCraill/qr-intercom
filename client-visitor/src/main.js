/**
 * Reads a response without assuming it is JSON.
 *
 * A stopped server, or a dev proxy in front of a stopped server, answers
 * 502/504 with an empty body. res.json() on that throws "Unexpected end of
 * JSON input", which says nothing about what actually failed and here would be
 * reported to a visitor standing at a door as "Resident Not Found".
 */
async function readBody(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) {
      throw new Error(`Server unreachable (HTTP ${res.status}). Is the intercom server running?`);
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from server (HTTP ${res.status}).`);
  }
}
const API_BASE = window.location.origin + "/api";
const WS_BASE = window.location.origin.replace(/^http/i, "ws");

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let residentId = null;
let visitorToken = null;
let sessionId = null;
let ws = null;
let localStream = null;
let peerConnection = null;
let currentResidentId = null;
let targetSessionId = null;
let isAutoCall = false;
let audioOnly = false;
let nativeBridge = false;

// â”€â”€ Audio State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let audioContext = null;
let audioWorkletNode = null;
let remoteAudioQueue = [];
let remoteAudioPlaying = false;
let isAudioMode = false;
let remoteDestNode = null;
let remoteAudioBacklog = [];   // Int16Array chunks arriving before audio mode starts
let speakerMode = (() => {
  try {
    return localStorage.getItem("visitorSpeakerMode") === "1";
  } catch (e) {
    return false;
  }
})();

// â”€â”€ Video Frame Capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let videoCaptureInterval = null;
let offscreenVideo = null;
let captureCanvas = null;
let captureCtx = null;

// â”€â”€ WebRTC State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let webRtcActive = false;
let webRtcAnswerReceived = false;
let webRtcOfferRetries = 0;
let webRtcFallbackTimer = null;

// â”€â”€ Resident Media State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let residentMediaSucceeded = false;
let residentMediaInProgress = false;
let mediaDiag = () => "Secure: ? | mediaDevices: ?";
let mediaRetryTimer = null;
let residentMediaEnabled = false;
let residentAudioSender = null;   // audio sender slot; real mic replaces the silent placeholder
let silenceCleanup = null;        // disposes the silent placeholder track
let callPhase = "none";
let webRtcNegotiationRetries = 0;

// â”€â”€ DOM Elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const $ = (sel) => document.querySelector(sel);
const headerTitle = $("#header-title");
const headerSubtitle = $("#header-subtitle");
const searchInput = $("#search-input");
const searchBox = $(".search-box");
const residentList = $("#resident-list");
const directorySection = $("#directory-section");
const callSection = $("#call-section");
const callStatusText = $("#call-status-text");
const pulseRing = $("#pulse-ring");
const localVideo = $("#local-video");
const remoteVideo = $("#remote-video");
const btnEndCall = $("#btn-end-call");
const btnToggleSpeaker = $("#btn-toggle-speaker");
const remoteAudio = $("#remote-audio");

// â”€â”€ Native Bridge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.handleNativeSignal = function (type, data) {
  console.log("[Bridge] Received:", type);
  let msg;
  if (typeof data === "string") {
    try {
      msg = JSON.parse(data);
    } catch (e) {
      try {
        msg = JSON.parse(atob(data));
      } catch (e2) {
        console.error("[Bridge] Failed to parse signal data");
        return;
      }
    }
  } else {
    msg = data;
  }
  msg.type = type;
  handleSignalingMessage(msg);
};

// â”€â”€ Status + resident media helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setStatus(text) {
  callStatusText.textContent = text;
  console.log("[Status]", text);
}

function keepTryingForMedia() {
  clearTimeout(mediaRetryTimer);
  mediaRetryTimer = setTimeout(() => {
    if (residentMediaEnabled && !residentMediaSucceeded && !residentMediaInProgress) {
      startResidentMedia();
    }
  }, 4000);
}

// A low-volume oscillator track keeps the audio m-line "sendrecv" in the
// SDP answer even before the real mic is available. When the mic arrives,
// replaceTrack() swaps it in â€” no renegotiation needed, audio flows both ways.
function createSilentAudioTrack() {
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    silenceCleanup = () => {
      try { osc.stop(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
      silenceCleanup = null;
    };
    return dest.stream.getAudioTracks()[0];
  } catch (err) {
    console.warn("[Media] Could not create silent placeholder track:", err);
    return null;
  }
}

function attachResidentAudio() {
  if (!audioOnly) return;
  const realTrack = localStream?.getAudioTracks()[0];
  if (residentAudioSender && realTrack) {
    if (silenceCleanup) silenceCleanup();
    residentAudioSender.replaceTrack(realTrack).catch((err) =>
      console.warn("[Media] replaceTrack failed:", err)
    );
    console.log("[Media] Mic attached to peer connection");
  }
}

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let initDone = false;

async function init() {
  if (initDone) return;
  initDone = true;

  const pathParts = window.location.pathname.split("/");
  const last = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
  const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
  residentId = isGuid(last) ? last : null;
  if (!residentId) {
    headerTitle.textContent = "Invalid QR Code";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/residents/${residentId}/directory`);
    if (!res.ok) throw new Error("Resident not found");
    const data = await readBody(res);

    headerTitle.textContent = data.resident.name;
    headerSubtitle.textContent = `Address: ${data.resident.unit}`;
    // A QR code names exactly one resident, so there is nothing to search.
    searchBox.classList.add("hidden");
    renderResidents([data.resident]);
  } catch (err) {
    console.error("[Init] Directory fetch failed:", err);
    if (allResidents.length === 0) {
      headerTitle.textContent = "Resident Not Found";
      headerSubtitle.textContent = "Please scan a valid QR code.";
    }
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const androidMode = urlParams.get("android") === "1";
  const autoCallResidentId = urlParams.get("call");
  audioOnly = urlParams.get("audioOnly") === "1";
  nativeBridge = urlParams.get("nativeBridge") === "1";

  if (androidMode && autoCallResidentId) {
    targetSessionId = urlParams.get("session") || null;
    directorySection.classList.add("hidden");
    callSection.classList.remove("hidden");
    callStatusText.textContent = "Waiting for call...";
    pulseRing.classList.remove("connected", "declined");
    residentMediaEnabled = true;
    callPhase = "resident";

    mediaDiag = () =>
      `Secure: ${window.isSecureContext ? "YES" : "NO"} | mediaDevices: ${!!navigator.mediaDevices} | mode: ${audioOnly ? "audio-only (+own camera preview)" : "audio+video"}`;
    console.log(`[Media] ${mediaDiag()}`);

    // Mic/camera start is deferred out of page-load and retried until it
    // succeeds (hardware can be momentarily busy â†’ NotReadableError). The
    // native side also re-triggers this from onPageFinished/onResume.
    window.startResidentMedia = startResidentMedia;
    setTimeout(startResidentMedia, 150);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && residentMediaEnabled && !residentMediaSucceeded) {
        console.log("[Media] Visibility change â†’ retrying media acquisition");
        startResidentMedia();
      }
    });
    return;
  }

  // Normal flow â€” create visitor session and connect WebSocket
  const sessionRes = await fetch(`${API_BASE}/residents/${residentId}/visitor-session`, {
    method: "POST",
  });
  const sessionData = await readBody(sessionRes);
  visitorToken = sessionData.token;
  sessionId = sessionData.sessionId;

  if (!nativeBridge) {
    connectWebSocket();
  }

  // The QR link carries ?call=, which used to ring the resident the moment the
  // page loaded. The visitor now sees the name and address first and rings
  // with the Call button, so a mis-scan or the wrong door never rings anyone.
  // Starting from a tap also lets mobile browsers start audio playback, which
  // they block when it is not triggered by the user.
}

// â”€â”€ Directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let allResidents = [];

function renderResidents(residents) {
  allResidents = residents;
  filterResidents("");
}

searchInput.addEventListener("input", (e) => {
  filterResidents(e.target.value.toLowerCase());
});

function filterResidents(query) {
  const filtered = allResidents.filter(
    (r) =>
      r.name.toLowerCase().includes(query) ||
      r.unit.toLowerCase().includes(query)
  );

  residentList.innerHTML = "";
  for (const r of filtered) {
    const li = document.createElement("li");
    li.className = "resident-item";
    li.innerHTML = `
      <div class="resident-info">
        <span class="resident-name">${escapeHtml(r.name)}</span>
        <span class="resident-unit">Address: ${escapeHtml(r.unit)}</span>
      </div>
      <button class="btn-call" data-resident-id="${r.id}">Call</button>
    `;
    li.querySelector(".btn-call").addEventListener("click", (e) => {
      e.stopPropagation();
      startCall(r.id, r.name);
    });
    residentList.appendChild(li);
  }
}

// â”€â”€ WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function connectWebSocket() {
  const wsUrl = `${WS_BASE}/ws`;
  console.log("[WS] Connecting to", wsUrl);
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    window.__diag.wsOpenAt = Date.now();
    window.__diag.wsOpenCount++;
    console.log(`[WS] open (${window.__diag.wsOpenCount}), Connected`);
    send({ type: "register", payload: "visitor" });
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const view = new Uint8Array(event.data);
      if (view.length > 0 && view[0] === 0x00) {
        handleBinaryAudio(event.data.slice(1));
      }
      return;
    }
    const msg = JSON.parse(event.data);
    handleSignalingMessage(msg);
  };

  ws.onclose = (event) => {
    window.__diag.wsCloseCount++;
    window.__diag.wsCloseReason = `${event.code}/${event.reason || "none"}`;
    window.__diag.wsClosedAt = Date.now();
    console.warn(`[WS] Closed code=${event.code} reason="${event.reason}" â€” reconnecting in 2s`);
    cleanupAudio();
    if (targetSessionId) {
      callStatusText.textContent = "Connection lost";
      setTimeout(endCall, 1500);
    }
    console.log("[WS] Disconnected, reconnecting in 2s...");
    setTimeout(connectWebSocket, 2000);
  };
}

function send({ type, to, ...rest }) {
  window.__diag.lastSent = type;
  if (type === "call-request") window.__diag.callRequestAt = Date.now();
  if (nativeBridge && window.AndroidBridge) {
    window.AndroidBridge.sendSignal(JSON.stringify({ type, to, ...rest }));
    return;
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, to, ...rest }));
  }
}

function sendBinaryAudio(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    const framed = new Uint8Array(data.byteLength + 1);
    framed[0] = 0x00;
    framed.set(new Uint8Array(data), 1);
    ws.send(framed);
    window.__audioStats.sent++;
  }
}

function sendBinaryVideo(jpegDataUrl) {
  if (ws?.readyState === WebSocket.OPEN) {
    const base64 = jpegDataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = 0x01;
    framed.set(bytes, 1);
    ws.send(framed);
  }
}

// â”€â”€ Audio Over WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const WIRE_RATE = 16000;
let nextPlayTime = 0;
window.__audioStats = { sent: 0, received: 0, backlog: 0, mode: "idle", audioprocess: 0 };
window.__audioContext = null;

// Averages each output sample over the input samples it replaces. Plain
// linear interpolation from 48 kHz down to 16 kHz folds everything above
// 8 kHz back into the voice band, which is the harsh, hissy edge on the
// visitor's voice.
function downsampleF32(src, srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(src.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += src[j];
    out[i] = end > start ? sum / (end - start) : src[start] || 0;
  }
  return out;
}

function resampleF32(src, srcRate, dstRate) {
  if (srcRate === dstRate || src.length === 0) return src;
  if (srcRate > dstRate) return downsampleF32(src, srcRate, dstRate);
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.round((src.length * dstRate) / srcRate));
  const out = new Float32Array(outLen);
  let idx = 0;
  for (let i = 0; i < outLen; i++) {
    if (idx >= src.length) idx = src.length - 1;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const s0 = src[i0];
    const s1 = i0 + 1 < src.length ? src[i0 + 1] : s0;
    out[i] = s0 + (s1 - s0) * frac;
    idx += ratio;
  }
  return out;
}

const PLAYOUT_DELAY_S = 0.1;

// ── Echo gate ──
// Level of the resident's voice that was most recently played, decaying
// over time, compared against the visitor's own mic level.
const ECHO_HOLD_MS = 200;     // keep the gate closed this long after the resident stops
const ECHO_DUCK_GAIN = 0.15;  // mic level while the resident is talking
let remoteLevel = 0;
let remoteLevelAt = 0;

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}

function noteRemoteLevel(buf) {
  const level = rms(buf);
  if (level > 0.01) {
    remoteLevel = Math.max(level, remoteLevel * 0.9);
    remoteLevelAt = performance.now();
  }
}

function echoGateGain(micBuf) {
  if (performance.now() - remoteLevelAt > ECHO_HOLD_MS) return 1;
  // The visitor talking clearly over the resident (a lot louder than the
  // echo would be) still goes through, so they can interrupt.
  return rms(micBuf) > remoteLevel * 2 ? 1 : ECHO_DUCK_GAIN;
}

function floatToPcm16(chunk) {
  const int16 = new Int16Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    const s = Math.max(-1, Math.min(1, chunk[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16.buffer;
}

function pickBufferSize(rate) {
  return rate >= 32000 ? 1024 : 256;
}

const SPEAKER_ON_VOLUME = 1.0;
const SPEAKER_OFF_VOLUME = 0.35;

function applySpeakerVolume() {
  if (!remoteAudio) return;
  remoteAudio.volume = speakerMode ? SPEAKER_ON_VOLUME : SPEAKER_OFF_VOLUME;
}

function updateSpeakerButton() {
  if (!btnToggleSpeaker) return;
  btnToggleSpeaker.textContent = "Speaker: " + (speakerMode ? "On" : "Off");
  btnToggleSpeaker.classList.toggle("active", speakerMode);
  applySpeakerVolume();
}

async function applyOutputRouting(audioElOrCtx) {
  if (!audioElOrCtx) return;
  let routed = false;
  if (typeof audioElOrCtx.setSinkId === "function" && speakerMode) {
    try {
      await audioElOrCtx.setSinkId({ type: "speaker" });
      console.log("[Audio] Output routed to loudspeaker");
      routed = true;
    } catch (err) {
      console.warn("[Audio] Speaker-type routing unsupported:", err.name || err);
    }
    if (!routed) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const speaker = devices.find(
          (d) =>
            d.kind === "audiooutput" &&
            d.deviceId !== "default" &&
            /speaker|speakers|loud|loudspeaker/i.test(d.label)
        );
        if (speaker) {
          await audioElOrCtx.setSinkId(speaker.deviceId);
          console.log(`[Audio] Routed to ${speaker.label}`);
          routed = true;
        }
      } catch (err) {
        console.warn("[Audio] Falling back to default output:", err.name || err);
      }
    }
  } else if (typeof audioElOrCtx.setSinkId === "function") {
    try {
      await audioElOrCtx.setSinkId("default");
      console.log("[Audio] Speaker OFF -> using default output");
      routed = true;
    } catch (err) {
      console.warn("[Audio] Speaker OFF setSinkId failed:", err.name || err);
    }
  }
  if (!routed) {
    console.warn("[Audio] setSinkId unavailable or no matching device; keeping current device");
  }
  updateSpeakerButton();
}

async function getMicStream(videoEnabled) {
  const audioC = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(
      videoEnabled ? { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: audioC } : { audio: audioC }
    );
  } catch (err) {
    console.warn("[Media] AEC constraints rejected, falling back:", err);
    return navigator.mediaDevices.getUserMedia(
      videoEnabled ? { video: true, audio: true } : { audio: true }
    );
  }
}

function errName(e) {
  return (e && (e.name || e.message)) || String(e);
}

// Mic-only acquisition. On Android WebView, requesting video+audio together
// makes the WHOLE call fail with NotReadableError when the CAMERA is busy â€”
// even though the mic itself is free. Voice should only ever depend on audio.
async function getAudioOnlyStream() {
  const audioC = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioC });
  } catch (err) {
    console.warn("[Media] Audio AEC constraints rejected, falling back:", errName(err));
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

// Adds a camera stream onto localStream purely for the on-device preview.
// It is never added to the peer connection, so a camera failure must never
// break the voice call.
async function capturePreviewCamera() {
  try {
    if (!localStream) return;
    const vid = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    for (const t of vid.getVideoTracks()) localStream.addTrack(t);
    localVideo.srcObject = localStream;
    localVideo.style.display = "block";
    console.log("[Media] Camera preview available");
  } catch (err) {
    console.warn("[Media] Camera preview unavailable (audio-only call continues):", errName(err));
  }
}

async function startResidentMedia() {
  if (!residentMediaEnabled || residentMediaSucceeded || residentMediaInProgress) return;
  if (!audioOnly) return;
  residentMediaInProgress = true;
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      }
      try {
        // MIC FIRST, camera optional (see getAudioOnlyStream).
        localStream = await getAudioOnlyStream();
        residentMediaSucceeded = true;
        attachResidentAudio();
        setStatus(`${mediaDiag()} | Ready`);
        console.log(`[Media] Mic acquired (attempt ${attempt}${lastError ? " â€” recovered from " + errName(lastError) : ""})`);
        capturePreviewCamera();
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[Media] Attempt ${attempt} failed:`, errName(err), err.message || "");
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    lastError = lastError || { name: "unknown" };
    setStatus(`${mediaDiag()} | ACCESS DENIED: ${errName(lastError)} (will keep retrying)`);
  } finally {
    residentMediaInProgress = false;
    keepTryingForMedia();
  }
}

async function startAudioMode() {
  if (isAudioMode) return;
  isAudioMode = true;

  try {
    if (!localStream) {
      localStream = await getMicStream(!audioOnly);
    }
    if (audioOnly) localVideo.style.display = "none";
    localVideo.srcObject = localStream;

    audioContext = new AudioContext();
    window.__audioContext = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    console.log(`[Audio] ctx created state=${audioContext.state} rate=${audioContext.sampleRate} tracks=${localStream.getAudioTracks().length}`);
    nextPlayTime = 0;
    const ctxRate = audioContext.sampleRate;
    const bufferSize = pickBufferSize(ctxRate);

    const source = audioContext.createMediaStreamSource(localStream);
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!isAudioMode) return;
      window.__audioStats.audioprocess++;
      event.outputBuffer.getChannelData(0).fill(0);
      const inputData = event.inputBuffer.getChannelData(0);
      // Copy: the input buffer is reused by the browser, and is scaled below.
      const resampled =
        ctxRate === WIRE_RATE ? Float32Array.from(inputData) : resampleF32(inputData, ctxRate, WIRE_RATE);
      // The mic is already level-controlled by the browser's autoGainControl.
      // It used to be pushed through tanh(x * 1.4) on top of that, which
      // clipped loud speech into distortion. Instead, while the resident's
      // voice is coming out of this phone's speaker, the mic is turned down so
      // that voice is not sent straight back as echo. Browsers do not
      // echo-cancel audio played through Web Audio, which is how this path
      // plays it, so nothing else stops the loop.
      const gain = echoGateGain(resampled);
      if (gain !== 1) {
        for (let i = 0; i < resampled.length; i++) resampled[i] *= gain;
      }
      sendBinaryAudio(floatToPcm16(resampled));
    };

    source.connect(processor);

    // Keep the processor in the rendering graph. A ScriptProcessor with no
    // output connection is a dead-end sink â€” Chrome never schedules
    // onaudioprocess for it, so no frames would ever be captured/sent.
    const silentTap = audioContext.createGain();
    silentTap.gain.value = 0;
    processor.connect(silentTap);
    silentTap.connect(audioContext.destination);
    setTimeout(() => {
      if (audioContext?.state === "suspended") {
        audioContext.resume().catch(() => {});
        console.warn("[Audio] Re-resuming AudioContext");
      }
    }, 600);

    remoteDestNode = audioContext.createMediaStreamDestination();
    remoteAudio.autoplay = true;
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    remoteAudio.srcObject = remoteDestNode.stream;
    try {
      await remoteAudio.play();
    } catch (err) {
      console.warn("[Audio] Speaker play blocked by browser policy:", err.name || err);
    }
    applyOutputRouting(remoteAudio);
    updateSpeakerButton();

    if (remoteAudioBacklog.length) {
      const backlog = remoteAudioBacklog;
      remoteAudioBacklog = [];
      window.__audioStats.backlog = 0;
      console.log(`[Audio] Flushing ${backlog.length} buffered remote frames`);
      for (const chunk of backlog) {
        window.__audioStats.received++;
        playPcmChunk(chunk);
      }
    }
    window.__audioStats.mode = "ws";

    callStatusText.textContent = "Audio connected";
    pulseRing.classList.add("connected");
    console.log(`[Audio] Started audio mode (ctxRate=${ctxRate}, buffer=${bufferSize})`);

    if (!audioOnly) startVideoCapture();
  } catch (err) {
    console.error("[Audio] Failed to start:", err);
    callStatusText.textContent = "Microphone access denied";
  }
}

function handleBinaryAudio(buffer) {
  if (!audioContext || !isAudioMode) {
    if (remoteAudioBacklog.length < 200) {
      remoteAudioBacklog.push(new Int16Array(buffer));
      window.__audioStats.backlog = remoteAudioBacklog.length;
    }
    return;
  }
  window.__audioStats.received++;
  playPcmChunk(new Int16Array(buffer));
}

function playPcmChunk(rawInt16) {
  if (!audioContext || rawInt16.length === 0) return;
  try {
    const floatIn = new Float32Array(rawInt16.length);
    for (let i = 0; i < rawInt16.length; i++) {
      floatIn[i] = rawInt16[i] / 32768;
    }

    const ctxRate = audioContext.sampleRate;
    const floatOut =
      ctxRate === WIRE_RATE ? floatIn : resampleF32(floatIn, WIRE_RATE, ctxRate);

    // Playback used to go through tanh(x * 1.8): almost double the volume,
    // clipped. That distorted the resident's voice and drove the speaker hard
    // enough to feed back into the visitor's mic. Volume now comes from the
    // Speaker button alone.
    noteRemoteLevel(floatIn);

    const audioBuffer = audioContext.createBuffer(1, floatOut.length, ctxRate);
    audioBuffer.getChannelData(0).set(floatOut);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(remoteDestNode || audioContext.destination);

    // Restart ~100 ms ahead after an underrun. 20 ms was less than ordinary
    // Wi-Fi/mobile jitter, so playback kept running dry and crackling.
    const now = audioContext.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + PLAYOUT_DELAY_S;
    }
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
  } catch (err) {
    console.error("[Audio] Playback error:", err);
  }
}

function cleanupAudio() {
  isAudioMode = false;
  stopVideoCapture();
  try {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  } catch (_) {}
  remoteDestNode = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

// â”€â”€ Video Frame Capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startVideoCapture() {
  if (videoCaptureInterval || audioOnly) return;

  offscreenVideo = document.createElement("video");
  offscreenVideo.srcObject = localStream;
  offscreenVideo.play();

  captureCanvas = document.createElement("canvas");
  captureCanvas.width = 240;
  captureCanvas.height = 180;
  captureCtx = captureCanvas.getContext("2d");

  videoCaptureInterval = setInterval(() => {
    if (!offscreenVideo || offscreenVideo.readyState < 2) return;
    try {
      captureCtx.drawImage(offscreenVideo, 0, 0, 240, 180);
      const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.45);
      sendBinaryVideo(dataUrl);
    } catch (err) {
      console.error("[Video] Capture error:", err);
    }
  }, 200);

  console.log("[Video] Started frame capture (5fps, 240x180, q=0.45)");
}

function stopVideoCapture() {
  if (videoCaptureInterval) {
    clearInterval(videoCaptureInterval);
    videoCaptureInterval = null;
  }
  offscreenVideo = null;
  captureCanvas = null;
  captureCtx = null;
}

// â”€â”€ Auto-Call (from QR ?call= parameter) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function waitForWsAndCall(residentId, attempts = 0) {
  if (ws?.readyState === WebSocket.OPEN) {
    const resident = allResidents.find((r) => r.id === residentId);
    if (resident) {
      startCall(residentId, resident.name);
    }
    return;
  }
  if (attempts < 50) {
    setTimeout(() => waitForWsAndCall(residentId, attempts + 1), 200);
  }
}

// â”€â”€ Signaling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function handleSignalingMessage(msg) {
  switch (msg.type) {
    case "call-accepted":
      targetSessionId = msg.from;
      callStatusText.textContent = "Connected â€” establishing audio...";
      pulseRing.classList.add("connected");
      if (nativeBridge && audioOnly) {
        // Resident WebView (callee): the visitor sends the offer, just wait.
        callStatusText.textContent = "Ready â€” waiting for voice connection...";
      } else {
        // Web visitor caller: voice travels over the WebSocket PCM channel â€”
        // the resident app answers with native AudioRecord/AudioTrack.
        startAudioMode();
      }
      break;

    case "offer":
      console.log("[Signal] Received offer from", msg.from);
      if (!peerConnection) createPeerConnection();
      handleOffer(msg);
      break;

    case "call-declined":
      callStatusText.textContent = "Declined";
      pulseRing.classList.add("declined");
      cleanupAudio();
      setTimeout(endCall, 1500);
      break;

    case "call-unavailable":
      callStatusText.textContent = "Resident unavailable";
      pulseRing.classList.add("declined");
      cleanupAudio();
      setTimeout(endCall, 2000);
      break;

    case "answer":
      console.log("[Signal] Received answer");
      handleAnswer(msg.payload);
      break;

    case "ice-candidate":
      handleRemoteIceCandidate(msg.payload);
      break;

    case "call-ended":
      callStatusText.textContent = "Call ended";
      cleanupAudio();
      endCall();
      break;
  }
}

// â”€â”€ WebRTC (kept for video calls between browsers) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

async function startCall(residentId, residentName) {
  currentResidentId = residentId;
  callPhase = "calling";
  directorySection.classList.add("hidden");
  callSection.classList.remove("hidden");
  callStatusText.textContent = `Calling ${residentName}...`;
  pulseRing.classList.remove("connected", "declined");

  try {
    // Audio is the priority: request the mic first, add the camera after.
    // On Android WebView a combined video+audio request fails entirely with
    // NotReadableError when the CAMERA is busy, killing voice for no reason.
    localStream = await getAudioOnlyStream();
    if (!audioOnly) {
      try {
        const vid = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
        });
        for (const t of vid.getVideoTracks()) localStream.addTrack(t);
      } catch (vErr) {
        console.warn("[Media] Camera unavailable, continuing audio-only:", errName(vErr));
      }
    }
    localVideo.srcObject = localStream;
    if (audioOnly) localVideo.style.display = "none";
  } catch (err) {
    console.error("Mic access denied:", errName(err));
    callStatusText.textContent = "Microphone access denied";
    return;
  }

  send({
    type: "call-request",
    residentId,
    payload: { visitorSessionId: sessionId },
  });
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (audioOnly) {
    // Resident: visitor's camera comes in recv-only. Audio is ALWAYS sendrecv:
    // a low-volume placeholder track keeps the SDP audio m-line bidirectional,
    // and the real mic is swapped in via replaceTrack() the moment it's available
    // (no renegotiation required).
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    const silent = createSilentAudioTrack();
    const audioTrans = silent
      ? peerConnection.addTransceiver(silent, { direction: "sendrecv" })
      : peerConnection.addTransceiver("audio", { direction: "sendrecv" });
    residentAudioSender = audioTrans.sender;
    if (localStream?.getAudioTracks()[0]) attachResidentAudio();
  } else if (localStream) {
    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        type: "ice-candidate",
        to: targetSessionId,
        payload: event.candidate,
      });
    }
  };

  peerConnection.ontrack = (event) => {
    webRtcActive = true;
    webRtcAnswerReceived = true;
    webRtcNegotiationRetries = 0;
    clearTimeout(webRtcFallbackTimer);
    webRtcFallbackTimer = null;
    const stream = event.streams[0];
    if (stream) {
      const hasVideo = stream.getVideoTracks().length > 0;
      remoteVideo.autoplay = true;
      remoteVideo.srcObject = stream;
      remoteVideo.style.display = hasVideo ? "block" : "none";
      remoteAudio.autoplay = true;
      remoteAudio.muted = false;
      remoteAudio.volume = 1.0;
      remoteAudio.srcObject = stream;
      remoteVideo.play().catch(() => {});
      remoteAudio.play().catch(() => {});
      console.log(`[WebRTC] Remote tracks: audio=${stream.getAudioTracks().length} video=${hasVideo}`);
    }
    applyOutputRouting(remoteAudio);
    setStatus("Audio connected");
    pulseRing.classList.add("connected");
  };

  peerConnection.onconnectionstatechange = () => {
    const pc = peerConnection;
    if (!pc) return;
    console.log(`[WebRTC] Connection state: ${pc.connectionState}`);
    if (pc.connectionState === "failed") {
      if (webRtcActive) {
        setStatus("Connection lost");
        endCall();
      } else {
        console.warn("[WebRTC] Connection failed before media");
        handleWebRtcFailure();
      }
    } else if (pc.connectionState === "connected") {
      setStatus("Audio connected");
      pulseRing.classList.add("connected");
    } else if (pc.connectionState === "disconnected") {
      console.warn("[WebRTC] Connection temporarily disconnected");
    }
  };
}

function teardownPeerConnection() {
  clearTimeout(webRtcFallbackTimer);
  webRtcFallbackTimer = null;
  webRtcActive = false;
  webRtcAnswerReceived = false;
  webRtcOfferRetries = 0;
  webRtcNegotiationRetries = 0;
  residentAudioSender = null;
  if (silenceCleanup) silenceCleanup();
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
}

function scheduleWebRtcFallback(reason, delayMs) {
  clearTimeout(webRtcFallbackTimer);
  webRtcFallbackTimer = setTimeout(() => {
    if (webRtcActive) return;
    console.warn("[WebRTC]", reason);
    handleWebRtcFailure();
  }, delayMs);
}

function handleWebRtcFailure() {
  if (callPhase === "none" || webRtcActive) return;
  teardownPeerConnection();
  if (webRtcNegotiationRetries < 3) {
    webRtcNegotiationRetries++;
    setStatus(`Voice connection failed â€” retrying (${webRtcNegotiationRetries}/3)...`);
    console.warn("[WebRTC] Re-negotiating");
    setTimeout(() => {
      if (callPhase !== "none") startWebRTCCall();
    }, 1200);
  } else {
    setStatus("Voice connection unavailable");
    setTimeout(endCall, 2000);
  }
}

async function startWebRTCCall() {
  clearTimeout(webRtcFallbackTimer);
  webRtcFallbackTimer = null;
  webRtcActive = false;
  webRtcAnswerReceived = false;
  try {
    if (!peerConnection) createPeerConnection();
    await createAndSendOffer();
    setStatus("Establishing voice connection...");
    scheduleWebRtcFallback("Voice connection not established in time", 12000);
    scheduleOfferRetry();
  } catch (err) {
    console.error("[WebRTC] Failed to create offer:", err);
    handleWebRtcFailure();
  }
}

function scheduleOfferRetry() {
  setTimeout(() => {
    if (webRtcActive || webRtcAnswerReceived) return;
    if (webRtcOfferRetries >= 2) return;
    const pc = peerConnection;
    if (pc && pc.signalingState === "have-local-offer") {
      webRtcOfferRetries++;
      console.log(`[WebRTC] No answer yet (retry ${webRtcOfferRetries}) â€” resending offer`);
      createAndSendOffer();
      scheduleOfferRetry();
    }
  }, 4000);
}

async function createAndSendOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  send({ type: "offer", to: targetSessionId, payload: offer });
}

async function handleAnswer(answer) {
  if (peerConnection && peerConnection.signalingState === "have-local-offer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    webRtcAnswerReceived = true;
    webRtcOfferRetries = 2; // no more offer resends needed
    if (!webRtcActive) scheduleWebRtcFallback("Media not flowing after answer", 12000);
  }
}

async function handleOffer(msg) {
  console.log(`[Signal] Building answer for offer from ${msg.from}`);
  try {
    if (!peerConnection) createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.payload));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    webRtcActive = true;
    clearTimeout(webRtcFallbackTimer);
    webRtcFallbackTimer = null;
    callStatusText.textContent = "Audio connected";
    pulseRing.classList.add("connected");
    send({ type: "answer", to: msg.from, payload: answer });
    console.log("[Signal] Answer sent");
  } catch (err) {
    console.error("[Signal] Answer creation failed:", errName(err));
  }
}

async function handleRemoteIceCandidate(candidate) {
  if (peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

// â”€â”€ End Call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnEndCall.addEventListener("click", () => {
  send({ type: "call-ended", to: targetSessionId });
  endCall();
});

btnToggleSpeaker.addEventListener("click", () => {
  speakerMode = !speakerMode;
  try {
    localStorage.setItem("visitorSpeakerMode", speakerMode ? "1" : "0");
  } catch (e) {}
  updateSpeakerButton();
  applyOutputRouting(remoteAudio);
});

function endCall(reason) {
  window.__diag.endCallReason = reason || "triggered";
  window.__diag.endCallCalls++;
  window.__diag.endCallAt = Date.now();
  console.warn(`[endCall] reason="${window.__diag.endCallReason}"`);
  clearTimeout(mediaRetryTimer);
  mediaRetryTimer = null;
  residentMediaEnabled = false;
  callPhase = "none";
  teardownPeerConnection();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  targetSessionId = null;
  currentResidentId = null;
  cleanupAudio();

  callSection.classList.add("hidden");

  if (isAutoCall) {
    setTimeout(() => window.close(), 500);
    return;
  }

  directorySection.classList.remove("hidden");
  searchInput.value = "";
  filterResidents("");
  pulseRing.classList.remove("connected", "declined");
  callStatusText.textContent = "Calling...";

  const url = new URL(window.location);
  url.searchParams.delete("call");
  window.history.replaceState({}, "", url);
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.__diag = {
  bootAt: Date.now(),
  wsOpenAt: 0,
  wsOpenCount: 0,
  wsCloseCount: 0,
  wsCloseReason: "",
  wsClosedAt: 0,
  callRequestAt: 0,
  lastSent: "",
  endCallCalls: 0,
  endCallReason: "",
  endCallAt: 0,
  pageHiddenAt: 0,
};
window.addEventListener("error", (event) => {
  console.error("[window.error]", event.message, (event.error && event.error.stack) || "");
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandledrejection]", (event.reason && event.reason.stack) || String(event.reason || ""));
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) window.__diag.pageHiddenAt = Date.now();
});
window.addEventListener("pagehide", () => {
  console.warn("[pagehide] page being hidden/unloaded");
});
updateSpeakerButton();
init();
