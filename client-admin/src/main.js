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
const loginEmail = $("#login-email");
const loginPassword = $("#login-password");
const loginError = $("#login-error");
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
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
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
      body: JSON.stringify({ email: loginEmail.value, password: loginPassword.value }),
    });
    token = data.token;
    localStorage.setItem("admin_token", token);
    adminInfo.textContent = `${data.admin.name} (${data.admin.email})`;
    showDashboard();
    loadAll();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
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
        <p>${esc(a.email)}</p>
      </div>
      <div class="actions">
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
              } ${f.placeholder ? `placeholder="${f.placeholder}"` : ""} /></label>`
      )
      .join("") +
    '<div class="modal-actions"><button type="button" class="btn btn-sm" id="btn-cancel">Cancel</button><button type="submit" class="btn btn-primary btn-sm">Save</button></div>';
  modalOverlay.classList.remove("hidden");

  modalForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(modalForm);
    const body = Object.fromEntries(fd);
    await onSubmit(body);
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

$("#btn-add-admin").onclick = () =>
  openModal("Add Admin", [
    { name: "name", label: "Name" },
    { name: "email", label: "Email", type: "email" },
    { name: "password", label: "Password", type: "password" },
  ], async (body) => { await api("/admin/admins", { method: "POST", body: JSON.stringify(body) }); });

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

if (token) {
  showDashboard();
  loadAll();
} else {
  showLogin();
}
