import QRCode from "qrcode";

export const QR_BASE = "https://desktop-obtdcvt.tail973ab1.ts.net";

export function residentQrUrl(resident) {
  return `${QR_BASE}/visit/${resident.id}?call=${resident.id}`;
}

export async function toDataUrl(text) {
  return QRCode.toDataURL(text, { width: 480, margin: 2 });
}

export function fileName(resident, ext) {
  const safe = (resident.unit || "unit").replace(/[^\w\-]+/g, "_");
  return `qr_intercom_${safe}.${ext}`;
}
