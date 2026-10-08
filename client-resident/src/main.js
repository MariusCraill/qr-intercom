const API_BASE = window.location.origin + "/api";
const WS_BASE = window.location.origin.replace(/^http/i, "ws");

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let authToken = null;
let residentInfo = null;
let ws = null;
let peerConnection = null;
let localStream = null;
let currentCallId = null;
let visitorSessionId = null;

// â”€â”€ DOM Elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const $ = (sel) => document.querySelector(sel);

/**
 * Reads a response without assuming it is JSON.
 *
 * A stopped server, or a dev proxy in front of a stopped server, answers
 * 502/504 with an empty body. res.json() on that throws "Unexpected end of
 * JSON input", which carries no information about what actually failed.
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

function notice(el, message, kind) {
  el.textContent = message;
  el.classList.remove("hidden", "is-error", "is-ok");
  if (kind) el.classList.add(kind);
}
const loginScreen = $("#login-screen");
const dashboard = $("#dashboard");
const loginForm = $("#login-form");
const loginError = $("#login-error");
const registerForm = $("#register-form");
const registerError = $("#register-error");
const loginSubtitle = $("#login-subtitle");
const registerLink = $("#register-link");
const loginLink = $("#login-link");
const residentName = $("#resident-name");
const residentUnit = $("#resident-unit");
const wsStatus = $("#ws-status");
const incomingCall = $("#incoming-call");
const callerInfo = $("#caller-info");
const activeCall = $("#active-call");
const idleState = $("#idle-state");
const remoteVideo = $("#remote-video");
const localVideo = $("#local-video");
const btnAccept = $("#btn-accept");
const btnDecline = $("#btn-decline");
const btnUnlock = $("#btn-unlock");
const btnEndCall = $("#btn-endCall") || $("#btn-end-call");
const callLogList = $("#call-log-list");
const btnLogout = $("#btn-logout");
const btnAccount = $("#btn-account");
const accountModal = $("#account-modal");
const accountForm = $("#account-form");
const accountError = $("#account-error");
const accountSuccess = $("#account-success");
const ringtoneAudio = $("#ringtone-audio");
const remoteAudio = $("#remote-audio");

// â”€â”€ Ringtone (Web Audio API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let ringtoneCtx = null;
let ringtoneInterval = null;

function startRingtone() {
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    let playing = true;
    function playTone() {
      if (!playing) return;
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain);
      gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 440;
      osc.type = "sine";
      gain.gain.value = 0.3;
      osc.start();
      setTimeout(() => {
        osc.frequency.value = 480;
      }, 200);
      setTimeout(() => {
        osc.stop();
        gain.disconnect();
      }, 400);
    }
    playTone();
    ringtoneInterval = setInterval(playTone, 600);
  } catch (e) {
    console.warn("Ringtone failed:", e);
  }
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneCtx) {
    ringtoneCtx.close().catch(() => {});
    ringtoneCtx = null;
  }
}

// â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function completeAuth(data) {
  authToken = data.token;
  residentInfo = data.resident;
  localStorage.setItem("intercom_token", authToken);
  localStorage.setItem("intercom_resident", JSON.stringify(residentInfo));
  showDashboard();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");

  const identifier = $("#login-identifier").value.trim();
  const password = $("#login-password").value;

  try {
    const res = await fetch(`${API_BASE}/auth/resident-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || "Login failed");
    await completeAuth(data);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  }
});

// â”€â”€ Register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showRegister() {
  loginError.classList.add("hidden");
  registerError.classList.add("hidden");
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
  loginLink.classList.remove("hidden");
  registerLink.classList.add("hidden");
  loginSubtitle.textContent = "Create your resident account";
}

// â”€â”€ Password reset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const forgotForm = $("#forgot-form");
const forgotMessage = $("#forgot-message");
const resetForm = $("#reset-form");
const resetMessage = $("#reset-message");

function showForgot() {
  loginError.classList.add("hidden");
  registerError.classList.add("hidden");
  forgotMessage.classList.add("hidden");
  loginForm.classList.add("hidden");
  registerForm.classList.add("hidden");
  forgotForm.classList.remove("hidden");
  loginLink.classList.add("hidden");
  registerLink.classList.add("hidden");
  loginSubtitle.textContent = "Reset your password";
}

function showResetForm() {
  loginError.classList.add("hidden");
  registerError.classList.add("hidden");
  resetMessage.classList.add("hidden");
  loginForm.classList.add("hidden");
  registerForm.classList.add("hidden");
  forgotForm.classList.add("hidden");
  resetForm.classList.remove("hidden");
  loginLink.classList.add("hidden");
  registerLink.classList.add("hidden");
  loginSubtitle.textContent = "Choose a new password";
}

$("#link-forgot").addEventListener("click", showForgot);

forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotMessage.classList.add("hidden");
  const identifier = $("#forgot-identifier").value.trim();
  try {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || "Request failed");
    notice(forgotMessage, data.message, "is-ok");
    $("#forgot-identifier").value = "";
  } catch (err) {
    notice(forgotMessage, err.message, "is-error");
  }
});

resetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  resetMessage.classList.add("hidden");
  const password = $("#reset-password").value;
  if (password !== $("#reset-confirm").value) {
    notice(resetMessage, "The two passwords do not match.", "is-error");
    return;
  }
  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    notice(resetMessage, "This link is missing its token. Request a new one.", "is-error");
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || "Request failed");
    // Drop the token so a refresh cannot replay a spent link.
    history.replaceState(null, "", location.pathname);
    notice(resetMessage, data.message, "is-ok");
    $("#reset-password").value = "";
    $("#reset-confirm").value = "";
    setTimeout(showLoginForm, 1200);
  } catch (err) {
    notice(resetMessage, err.message, "is-error");
  }
});

function showLoginForm() {
  loginError.classList.add("hidden");
  registerError.classList.add("hidden");
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  registerLink.classList.remove("hidden");
  loginLink.classList.add("hidden");
  loginSubtitle.textContent = "Sign in to receive visitor calls";
}

registerLink.addEventListener("click", showRegister);
loginLink.addEventListener("click", showLoginForm);

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.classList.add("hidden");

  const body = {
    unit: $("#reg-unit").value.trim(),
    name: $("#reg-name").value.trim(),
    phone: $("#reg-phone").value.trim(),
    email: $("#reg-email").value.trim() || null,
    password: $("#reg-password").value,
  };

  try {
    const res = await fetch(`${API_BASE}/auth/resident-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || "Registration failed");
    await completeAuth(data);
  } catch (err) {
    registerError.textContent = err.message;
    registerError.classList.remove("hidden");
  }
});

// â”€â”€ Init from stored session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initFromStorage() {
  // A reset link wins over a stored session: the link's whole job is to set a
  // new password, and a live dashboard would hide the form behind it.
  if (new URLSearchParams(location.search).get("token")) {
    localStorage.removeItem("intercom_token");
    localStorage.removeItem("intercom_resident");
    showResetForm();
    return;
  }
  const stored = localStorage.getItem("intercom_token");
  const storedResident = localStorage.getItem("intercom_resident");
  if (stored && storedResident) {
    authToken = stored;
    residentInfo = JSON.parse(storedResident);
    showDashboard();
  }
}

// â”€â”€ Logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnLogout.addEventListener("click", () => {
  if (ws) ws.close();
  stopRingtone();
  endCall();
  authToken = null;
  residentInfo = null;
  localStorage.removeItem("intercom_token");
  localStorage.removeItem("intercom_resident");
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
});

// â”€â”€ Account Edit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnAccount.addEventListener("click", () => {
  $("#acct-name").value = residentInfo.name || "";
  $("#acct-phone").value = "";
  $("#acct-email").value = "";  // will be fetched
  $("#acct-password").value = "";
  accountError.classList.add("hidden");
  accountSuccess.classList.add("hidden");
  accountModal.classList.remove("hidden");
  fetch(`${API_BASE}/residents/me`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })
    .then((r) => r.json())
    .then((d) => {
      if (d.resident) {
        $("#acct-name").value = d.resident.name || "";
        $("#acct-phone").value = d.resident.phone || "";
        $("#acct-email").value = d.resident.email || "";
      }
    })
    .catch(() => {});
});

$("#btn-modal-close").onclick = () => accountModal.classList.add("hidden");
$("#btn-acct-cancel").onclick = () => accountModal.classList.add("hidden");
accountModal.addEventListener("click", (e) => {
  if (e.target === accountModal) accountModal.classList.add("hidden");
});

accountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  accountError.classList.add("hidden");
  accountSuccess.classList.add("hidden");

  const body = {
    name: $("#acct-name").value,
    phone: $("#acct-phone").value,
    email: $("#acct-email").value || null,
  };
  const pw = $("#acct-password").value;
  if (pw) body.password = pw;

  try {
    const res = await fetch(`${API_BASE}/residents/me`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || "Update failed");

    residentInfo.name = body.name;
    localStorage.setItem("intercom_resident", JSON.stringify(residentInfo));
    residentName.textContent = body.name;

    accountSuccess.textContent = "Account updated";
    accountSuccess.classList.remove("hidden");
    setTimeout(() => accountModal.classList.add("hidden"), 1200);
  } catch (err) {
    accountError.textContent = err.message;
    accountError.classList.remove("hidden");
  }
});

// â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  residentName.textContent = residentInfo.name;
  residentUnit.textContent = `Unit ${residentInfo.unit}`;
  showIdle();
  connectWebSocket();
  registerServiceWorker();
  await generateQRCode();
}

async function generateQRCode() {
  const QRCode = (await import("qrcode")).default;
  const url = `${window.location.origin}/visit/${residentInfo.id}?call=${residentInfo.id}`;

  const container = $("#qr-code");
  container.innerHTML = "";

  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, url, {
    width: 200,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  container.appendChild(canvas);

  const urlEl = $("#qr-url");
  urlEl.textContent = url;
}

function showIdle() {
  incomingCall.classList.add("hidden");
  activeCall.classList.add("hidden");
  idleState.classList.remove("hidden");
}

function showIncoming(visitorId) {
  idleState.classList.add("hidden");
  activeCall.classList.add("hidden");
  incomingCall.classList.remove("hidden");
  callerInfo.textContent = `Visitor calling you`;
  visitorSessionId = visitorId;
  startRingtone();
}

function showActiveCall() {
  incomingCall.classList.add("hidden");
  idleState.classList.add("hidden");
  activeCall.classList.remove("hidden");
}

// â”€â”€ WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function connectWebSocket() {
  const wsUrl = `${WS_BASE}/ws`;
  console.log("[WS] Connecting to", wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    wsStatus.textContent = "Online";
    wsStatus.className = "status-badge online";
    send({
      type: "register",
      payload: "resident",
      residentId: residentInfo.id,
    });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSignalingMessage(msg);
  };

  ws.onclose = () => {
    wsStatus.textContent = "Offline";
    wsStatus.className = "status-badge offline";
    setTimeout(connectWebSocket, 3000);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// â”€â”€ Signaling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function handleSignalingMessage(msg) {
  switch (msg.type) {
    case "call-request":
      currentCallId = msg.from;
      showIncoming(msg.from);
      triggerNotification("Incoming visitor call");
      break;

    case "offer":
      handleOffer(msg);
      break;

    case "ice-candidate":
      handleRemoteIceCandidate(msg.payload);
      break;

    case "call-ended":
      endCall();
      break;
  }
}

// â”€â”€ Accept / Decline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnAccept.addEventListener("click", async () => {
  stopRingtone();
  send({ type: "call-accepted", to: currentCallId });
  showActiveCall();
  await setupLocalMedia();
});

btnDecline.addEventListener("click", () => {
  stopRingtone();
  send({ type: "call-declined", to: currentCallId });
  endCall();
});

// â”€â”€ WebRTC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

async function setupLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: true,
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error("Mic access denied:", err);
  }
}

async function handleOffer(msg) {
  if (!peerConnection) createPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.payload));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  send({ type: "answer", to: msg.from, payload: answer });
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "ice-candidate", to: currentCallId, payload: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteAudio.srcObject = event.streams[0];
  };

  peerConnection.onconnectionstatechange = () => {
    if (
      peerConnection.connectionState === "disconnected" ||
      peerConnection.connectionState === "failed"
    ) {
      endCall();
    }
  };
}

async function handleRemoteIceCandidate(candidate) {
  if (peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

// â”€â”€ End Call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnEndCall.addEventListener("click", () => {
  send({ type: "call-ended", to: currentCallId });
  endCall();
});

function endCall() {
  stopRingtone();
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  remoteAudio.srcObject = null;
  currentCallId = null;
  visitorSessionId = null;
  showIdle();
}

// â”€â”€ Unlock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
btnUnlock.addEventListener("click", async () => {
  btnUnlock.disabled = true;
  btnUnlock.textContent = "Unlocking...";

  try {
    const res = await fetch(`${API_BASE}/residents/me/unlock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ callId: currentCallId }),
    });

    if (!res.ok) throw new Error("Unlock failed");

    btnUnlock.textContent = "Door Unlocked";
    btnUnlock.style.background = "var(--success)";
    setTimeout(() => {
      btnUnlock.disabled = false;
      btnUnlock.textContent = "Unlock";
      btnUnlock.style.background = "";
    }, 3000);
  } catch (err) {
    btnUnlock.textContent = "Unlock Failed";
    setTimeout(() => {
      btnUnlock.disabled = false;
      btnUnlock.textContent = "Unlock";
    }, 2000);
  }
});

// â”€â”€ Push Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function registerServiceWorker() {
  if ("serviceWorker" in navigator && "PushManager" in window) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      console.log("[SW] Registered");

      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        const subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            "YOUR_VAPID_PUBLIC_KEY_HERE"
          ),
        });

        await fetch(`${API_BASE}/residents/${residentInfo.id}/push-subscription`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(subscription),
        });
      }
    } catch (err) {
      console.warn("[SW] Registration failed:", err);
    }
  }
}

function triggerNotification(body) {
  if (Notification.permission === "granted") {
    new Notification("QR Intercom", {
      body,
      icon: "/resident/icon-192.png",
      badge: "/resident/icon-192.png",
      tag: "incoming-call",
      requireInteraction: true,
    });
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
initFromStorage();
