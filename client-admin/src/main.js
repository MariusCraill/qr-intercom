import {
  residentQrUrl,
  toDataUrl,
  fileName,
} from "./qr.js";

const API = "/api";

let token = localStorage.getItem("admin_token");
let admins = [];
let residents = [];
let editingId = null;
let editingType = null;
let qrResidentId = null;
let qrDataUrl = null;

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const loginScreen = $("#login-screen");
const loginForm = $("#login-form");
const loginIdentifier = $("#login-identifier");
const loginPassword = $("#login-password");
const loginError = $("#login-error");
const forgotForm = $("#forgot-form");
const forgotIdentifier = $("#forgot-identifier");
const forgotMessage = $("#forgot-message");
const resetForm = $("#reset-form");
const resetPassword = $("#reset-password");
const resetConfirm = $("#reset-confirm");
const resetMessage = $("#reset-message");
const dashboard = $("#dashboard");
const adminInfo = $("#admin-info");
const btnLogout = $("#btn-logout");
const modalOverlay = $("#modal-overlay");
const modalTitle = $("#modal-title");
const modalForm = $("#modal-form");
const btnModalClose = $("#btn-modal-close");
const residentsList = $("#residents-list");
const adminsList = $("#admins-list");
const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");

// ── Auth helpers ─────────────────────────────────────────────────

/**
 * Reads a response without assuming it is JSON.
 *
 * When the server is down, or a dev proxy sits in front of a server that is
 * down, the answer is 502/504 with an empty body. Calling res.json() on that
 * throws "Unexpected end of JSON input", which says nothing about what
 * actually happened and looks identical to a bug in this portal.
 */
async function readBody(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) {
      throw new Error(
        `Server unreachable (HTTP ${res.status}). Is the intercom server running?`,
      );
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from server (HTTP ${res.status}).`);
  }
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await readBody(res);
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function notice(el, message, kind) {
  el.textContent = message;
  el.classList.remove("hidden", "is-error", "is-ok");
  if (kind) el.classList.add(kind);
}

function showLogin() {
  token = null;
  localStorage.removeItem("admin_token");
  loginScreen.classList.remove("hidden");
  dashboard.classList.add("hidden");
}

function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
}

// ── Login ────────────────────────────────────────────────────────
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  try {
    const data = await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: loginIdentifier.value.trim(),
        password: loginPassword.value,
      }),
    });
    token = data.token;
    localStorage.setItem("admin_token", token);
    const how = data.admin.phone ? ` (${data.admin.phone})` : ` (${data.admin.email})`;
    adminInfo.textContent = `${data.admin.name}${how}`;
    loginPassword.value = "";
    showDashboard();
    loadAll();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  }
});

// ── Password reset ───────────────────────────────────────────────
function showOnly(form) {
  for (const f of [loginForm, forgotForm, resetForm]) {
    f.classList.toggle("hidden", f !== form);
  }
}

$("#link-forgot").addEventListener("click", () => {
  forgotMessage.classList.add("hidden");
  showOnly(forgotForm);
  forgotIdentifier.focus();
});

$("#link-back-login").addEventListener("click", () => showOnly(loginForm));

forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotMessage.classList.add("hidden");
  try {
    const data = await api("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ identifier: forgotIdentifier.value.trim() }),
    });
    notice(forgotMessage, data.message, "is-ok");
    forgotForm.querySelector('input[type="text"]').value = "";
  } catch (err) {
    notice(forgotMessage, err.message, "is-error");
  }
});

resetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  resetMessage.classList.add("hidden");
  if (resetPassword.value !== resetConfirm.value) {
    notice(resetMessage, "The two passwords do not match.", "is-error");
    return;
  }
  const tokenFromUrl = new URLSearchParams(location.search).get("token");
  if (!tokenFromUrl) {
    notice(resetMessage, "This link is missing its token. Request a new one.", "is-error");
    return;
  }
  try {
    const data = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: tokenFromUrl, password: resetPassword.value }),
    });
    // Drop the token from the address bar so a refresh cannot replay it.
    history.replaceState(null, "", location.pathname);
    notice(resetMessage, data.message, "is-ok");
    resetPassword.value = "";
    resetConfirm.value = "";
    setTimeout(() => showOnly(loginForm), 1200);
  } catch (err) {
    notice(resetMessage, err.message, "is-error");
  }
});

btnLogout.addEventListener("click", showLogin);

// ── Tabs ─────────────────────────────────────────────────────────
tabs.forEach((t) =>
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    tabContents.forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(`#tab-${t.dataset.tab}`).classList.add("active");
  })
);

// ── Load data ────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [r, a] = await Promise.all([
      api("/admin/residents"),
      api("/admin/admins"),
    ]);
    residents = r.residents;
    admins = a.admins;
    renderResidents();
    renderAdmins();
  } catch {
    showLogin();
  }
}

function renderResidents() {
  if (!residents.length) { residentsList.innerHTML = '<p class="empty-text">No residents</p>'; return; }
  residentsList.innerHTML = residents
    .map(
      (r) => `
    <div class="data-card">
      <div class="info">
        <h3>${esc(r.name)} — Unit ${esc(r.unit)}</h3>
        <p>${esc(r.phone || "No phone")}${r.email ? " · " + esc(r.email) : ""}</p>
      </div>
      <div class="actions">
        <button class="btn btn-sm" onclick="showResidentQr('${r.id}')">QR</button>
        <button class="btn btn-sm" onclick="editResident('${r.id}')">Edit</button>
        <button class="btn btn-sm" onclick="resetResidentPassword('${r.id}')">Reset password</button>
        <button class="btn btn-danger btn-sm" onclick="deleteResident('${r.id}')">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function renderAdmins() {
  if (!admins.length) { adminsList.innerHTML = '<p class="empty-text">No admins</p>'; return; }
  adminsList.innerHTML = admins
    .map(
      (a) => `
    <div class="data-card">
      <div class="info">
        <h3>${esc(a.name)}</h3>
        <p>${esc(a.email)}${a.phone ? " · " + esc(a.phone) : " · no phone set"}</p>
      </div>
      <div class="actions">
        <button class="btn btn-sm" onclick="editAdmin('${a.id}')">Edit</button>
        <button class="btn btn-sm" onclick="resetAdminPassword('${a.id}')">Reset password</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAdmin('${a.id}')">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

// ── Modal ────────────────────────────────────────────────────────
function openModal(title, fields, onSubmit) {
  editingType = null;
  editingId = null;
  modalTitle.textContent = title;
  modalForm.innerHTML =
    fields
      .map(
        (f) =>
          f.type === "select"
            ? `<label><span>${f.label}</span><select name="${f.name}" required>${f.options
                .map((o) => `<option value="${o.value}">${o.label}</option>`)
                .join("")}</select></label>`
            : `<label><span>${f.label}</span><input type="${f.type || "text"}" name="${f.name}" ${
                f.required !== false ? "required" : ""
              } ${f.placeholder ? `placeholder="${f.placeholder}"` : ""} ${
                // Without this the browser fills the signed-in admin's own saved
                // password into "New Password", silently changing it on Save.
                f.type === "password" ? 'autocomplete="new-password"' : ""
              } /></label>`
      )
      .join("") +
    '<p id="modal-error" class="error-text hidden"></p>' +
    '<div class="modal-actions"><button type="button" class="btn btn-sm" id="btn-cancel">Cancel</button><button type="submit" class="btn btn-primary btn-sm">Save</button></div>';
  modalOverlay.classList.remove("hidden");

  // A rejected save (password too short or too common, phone already in use)
  // used to throw out of this handler unseen, leaving the dialog open with no
  // message, so it looked as if editing did nothing.
  modalForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(modalForm);
    const body = Object.fromEntries(fd);
    const errorEl = $("#modal-error");
    errorEl.classList.add("hidden");
    try {
      await onSubmit(body);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modalOverlay.classList.add("hidden");
    loadAll();
  };
  $("#btn-cancel").onclick = () => modalOverlay.classList.add("hidden");
}

btnModalClose.onclick = () => modalOverlay.classList.add("hidden");
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) modalOverlay.classList.add("hidden"); });

// ── Add / Edit handlers ──────────────────────────────────────────
$("#btn-add-resident").onclick = () =>
  openModal("Add Resident", [
    { name: "unit", label: "Unit", placeholder: "e.g. 101" },
    { name: "name", label: "Name" },
    { name: "phone", label: "Phone (login)", type: "tel", placeholder: "e.g. +65 9001 0001" },
    { name: "password", label: "Password", type: "password" },
    { name: "email", label: "Email (optional)", type: "email", required: false },
  ], async (body) => { await api("/admin/residents", { method: "POST", body: JSON.stringify(body) }); });

window.editResident = (id) => {
  const r = residents.find((x) => x.id === id);
  if (!r) return;
  editingType = "resident";
  editingId = id;
  openModal("Edit Resident", [
    { name: "unit", label: "Unit" },
    { name: "name", label: "Name" },
    { name: "phone", label: "Phone (login)", type: "tel" },
    { name: "password", label: "New Password (blank = keep)", type: "password", required: false },
    { name: "email", label: "Email (optional)", type: "email", required: false },
  ], async (body) => {
    const clean = {};
    if (body.unit) clean.unit = body.unit;
    if (body.name) clean.name = body.name;
    if (body.phone) clean.phone = body.phone;
    if (body.password) clean.password = body.password;
    clean.email = body.email || null;
    await api(`/admin/residents/${id}`, { method: "PUT", body: JSON.stringify(clean) });
  });
  // pre-fill
  setTimeout(() => {
    modalForm.querySelector('[name="unit"]').value = r.unit;
    modalForm.querySelector('[name="name"]').value = r.name;
    modalForm.querySelector('[name="phone"]').value = r.phone || "";
    modalForm.querySelector('[name="email"]').value = r.email || "";
  }, 0);
};

window.deleteResident = async (id) => {
  if (!confirm("Delete this resident?")) return;
  await api(`/admin/residents/${id}`, { method: "DELETE" });
  loadAll();
};

/**
 * Hands a resident a fresh password.
 *
 * There is nothing else that can work: the server only ever stores a bcrypt
 * hash, and a resident with no email on file cannot receive a self-service
 * link. So this confirms first, then shows the generated value on screen to be
 * read over the phone - it is never emailed and never stored in the clear.
 */
window.resetResidentPassword = async (id) => {
  const r = residents.find((x) => x.id === id);
  if (!r) return;
  if (!confirm(`Set a new password for ${r.name} (Unit ${r.unit})?\n\nTheir current password will stop working.`)) {
    return;
  }
  try {
    const data = await api(`/admin/residents/${id}/reset-password`, { method: "POST" });
    openModal(`New password for ${data.resident.name}`, [
      {
        name: "generated",
        label: "Give them this password (it is not saved anywhere)",
        type: "text",
        required: false,
        placeholder: data.password,
      },
    ], async () => {});
    const input = modalForm.querySelector('[name="generated"]');
    input.value = data.password;
    input.readOnly = true;
    input.classList.add("temp-password");
    input.focus();
    input.select();
  } catch (err) {
    alert(err.message);
  }
};

$("#btn-add-admin").onclick = () =>
  openModal("Add Admin", [
    { name: "name", label: "Name" },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone (can sign in with this)", type: "tel", required: false, placeholder: "e.g. +65 9001 0001" },
    { name: "password", label: "Password", type: "password" },
  ], async (body) => { await api("/admin/admins", { method: "POST", body: JSON.stringify(body) }); });

window.editAdmin = (id) => {
  const a = admins.find((x) => x.id === id);
  if (!a) return;
  editingType = "admin";
  editingId = id;
  openModal("Edit Admin", [
    { name: "name", label: "Name" },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone (can sign in with this)", type: "tel", required: false },
    { name: "password", label: "New Password (blank = keep)", type: "password", required: false },
  ], async (body) => {
    // phone is sent even when blank: an empty value is how the number is
    // cleared, which the server treats as a change rather than a no-op.
    await api(`/admin/admins/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: body.name,
        email: body.email,
        phone: body.phone || "",
        ...(body.password ? { password: body.password } : {}),
      }),
    });
  });
  setTimeout(() => {
    modalForm.querySelector('[name="name"]').value = a.name;
    modalForm.querySelector('[name="email"]').value = a.email;
    modalForm.querySelector('[name="phone"]').value = a.phone || "";
  }, 0);
};

window.resetAdminPassword = async (id) => {
  const a = admins.find((x) => x.id === id);
  if (!a) return;
  if (!confirm(`Set a new password for ${a.name}?\n\nTheir current password will stop working.`)) return;
  try {
    const data = await api(`/admin/admins/${id}/reset-password`, { method: "POST" });
    openModal(`New password for ${data.admin.name}`, [
      {
        name: "generated",
        label: "Give them this password (it is not saved anywhere)",
        type: "text",
        required: false,
        placeholder: data.password,
      },
    ], async () => {});
    const input = modalForm.querySelector('[name="generated"]');
    input.value = data.password;
    input.readOnly = true;
    input.classList.add("temp-password");
    input.focus();
    input.select();
  } catch (err) {
    alert(err.message);
  }
};

window.deleteAdmin = async (id) => {
  if (!confirm("Delete this admin?")) return;
  await api(`/admin/admins/${id}`, { method: "DELETE" });
  loadAll();
};

// ── Resident QR ──────────────────────────────────────────────────
const qrOverlay = $("#qr-overlay");
const btnQrClose = $("#btn-qr-close");
const btnQrPrint = $("#btn-qr-print");
const btnQrExport = $("#btn-qr-export");

function qrResident() {
  return residents.find((r) => r.id === qrResidentId);
}

window.showResidentQr = async (id) => {
  const r = residents.find((x) => x.id === id);
  if (!r) return;
  qrResidentId = id;
  const url = residentQrUrl(r);
  qrDataUrl = await toDataUrl(url);
  $("#qr-image").src = qrDataUrl;
  $("#qr-title").textContent = `QR — ${r.name || r.unit}`;
  $("#qr-address").textContent = `Address: ${r.unit || ""}`;
  $("#qr-url").textContent = url;
  qrOverlay.classList.remove("hidden");
};

btnQrClose.onclick = () => qrOverlay.classList.add("hidden");

const QR_OPTS_KEY = "admin_qr_print_opts";
const qrIncs = {
  name: $("#qr-inc-name"),
  address: $("#qr-inc-address"),
  url: $("#qr-inc-url"),
  qr: $("#qr-inc-qr"),
};

function loadQrOpts() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(QR_OPTS_KEY)); } catch (_) {}
  for (const k of Object.keys(qrIncs)) {
    qrIncs[k].checked = saved ? saved[k] !== false : true;
  }
}

function saveQrOpts() {
  const o = {};
  for (const k of Object.keys(qrIncs)) o[k] = qrIncs[k].checked;
  try { localStorage.setItem(QR_OPTS_KEY, JSON.stringify(o)); } catch (_) {}
}

Object.values(qrIncs).forEach((el) => el.addEventListener("change", saveQrOpts));

btnQrPrint.onclick = () => {
  saveQrOpts();
  const r = qrResident();
  if (!r) return;
  const w = window.open("", "_blank", "width=520,height=640");
  if (!w) return;
  const lines = [];
  if (qrIncs.name.checked) lines.push(`<h2>${r.name}</h2>`);
  if (qrIncs.address.checked) lines.push(`<p class="addr">Address: ${r.unit}</p>`);
  if (qrIncs.qr.checked) lines.push(`<img src="${qrDataUrl}" />`);
  if (qrIncs.url.checked) lines.push(`<p class="url">${document.getElementById("qr-url").textContent}</p>`);
  w.document.write(`<!doctype html><html><head><title>Resident QR</title>
    <style>
      body{font-family:sans-serif;text-align:center;margin:40px;}
      img{width:360px;height:360px;image-rendering:pixelated;}
      h2{margin:0 0 4px;} .addr{color:#333;margin-bottom:20px;}
      .url{font-size:11px;color:#888;word-break:break-all;margin-top:16px;}
    </style></head>
    <body>
      ${lines.join("\n      ")}
    </body></html>`);
  w.document.close();
  w.focus();
  w.print();
};
btnQrExport.onclick = () => {
  const r = qrResident();
  if (!r) return;
  const a = document.createElement("a");
  a.href = qrDataUrl;
  a.download = fileName(r, "png");
  a.click();
};
qrOverlay.addEventListener("click", (e) => { if (e.target === qrOverlay) qrOverlay.classList.add("hidden"); });

// ── Helpers ──────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// ── Boot ─────────────────────────────────────────────────────────
loadQrOpts();

// A reset link wins over a stored session: the point is to set a new
// password, and leaving a half-signed-in dashboard behind would hide the form.
const resetToken = new URLSearchParams(location.search).get("token");
if (resetToken) {
  token = null;
  localStorage.removeItem("admin_token");
  showLogin();
  showOnly(resetForm);
} else if (token) {
  showDashboard();
  loadAll();
} else {
  showLogin();
}
