/**
 * Minimal eWeLink (CoolKit) Open API v2 client: OAuth sign-in, device list
 * and switching one device on, for opening a gate from a call.
 *
 * Everything that needs the app secret happens here on the server, so the
 * secret never ships inside the Android APK. Register an app at
 * https://dev.ewelink.cc, add the redirect URL
 *   <PUBLIC_BASE_URL>/api/ewelink/callback
 * and set EWELINK_APP_ID / EWELINK_APP_SECRET in server/.env.
 */
import { createHmac, randomBytes } from "node:crypto";

export interface EwelinkConfig {
  appId: string;
  appSecret: string;
}

export interface EwelinkTokens {
  region: string;
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  accessExpiresAt: number;
}

export interface EwelinkDevice {
  id: string;
  name: string;
  online: boolean;
  /** Channel numbers for multi-channel relays; empty for single-channel. */
  outlets: number[];
}

const OAUTH_PAGE = "https://c2ccdn.coolkit.cc/oauth/index.html";
const REGIONS = new Set(["cn", "as", "us", "eu"]);

export function apiHost(region: string): string {
  const r = REGIONS.has(region) ? region : "eu";
  return r === "cn" ? "https://cn-apia.coolkit.cn" : `https://${r}-apia.coolkit.cc`;
}

function sign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64");
}

function nonce(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

export function ewelinkConfigFromEnv(): EwelinkConfig | null {
  const appId = (process.env.EWELINK_APP_ID || "").trim();
  const appSecret = (process.env.EWELINK_APP_SECRET || "").trim();
  return appId && appSecret ? { appId, appSecret } : null;
}

/** The eWeLink sign-in page. The person signs in there, never in our app. */
export function authorizeUrl(cfg: EwelinkConfig, redirectUrl: string, state: string): string {
  const seq = Date.now().toString();
  const params = new URLSearchParams({
    clientId: cfg.appId,
    seq,
    authorization: sign(cfg.appSecret, `${cfg.appId}_${seq}`),
    redirectUrl,
    grantType: "authorization_code",
    state,
    nonce: nonce(),
    showQRCode: "false",
  });
  return `${OAUTH_PAGE}?${params}`;
}

async function call(
  cfg: EwelinkConfig,
  region: string,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; accessToken?: string } = {},
): Promise<any> {
  const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CK-Appid": cfg.appId,
    "X-CK-Nonce": nonce(),
    Authorization: opts.accessToken
      ? `Bearer ${opts.accessToken}`
      : `Sign ${sign(cfg.appSecret, bodyStr ?? "")}`,
  };
  const res = await fetch(`${apiHost(region)}${path}`, { method, headers, body: bodyStr });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || (json.error && json.error !== 0)) {
    const err = new Error(`eWeLink ${path} failed: ${json.msg || res.status} (error ${json.error ?? res.status})`);
    (err as any).code = json.error ?? res.status;
    throw err;
  }
  return json.data ?? {};
}

export async function exchangeCode(
  cfg: EwelinkConfig,
  region: string,
  code: string,
  redirectUrl: string,
): Promise<EwelinkTokens> {
  const data = await call(cfg, region, "POST", "/v2/user/oauth/token", {
    body: { code, redirectUrl, grantType: "authorization_code" },
  });
  return {
    region,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAt: Number(data.atExpiredTime) || Date.now() + 30 * 24 * 3600 * 1000,
  };
}

export async function refresh(cfg: EwelinkConfig, tokens: EwelinkTokens): Promise<EwelinkTokens> {
  const data = await call(cfg, tokens.region, "POST", "/v2/user/refresh", {
    body: { rt: tokens.refreshToken },
    accessToken: tokens.accessToken,
  });
  return {
    region: tokens.region,
    accessToken: data.at,
    refreshToken: data.rt,
    // The refresh response carries no expiry; eWeLink access tokens last 30 days.
    accessExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  };
}

export async function listDevices(cfg: EwelinkConfig, tokens: EwelinkTokens): Promise<EwelinkDevice[]> {
  const data = await call(cfg, tokens.region, "GET", "/v2/device/thing?num=0", {
    accessToken: tokens.accessToken,
  });
  const devices: EwelinkDevice[] = [];
  for (const item of data.thingList || []) {
    // itemType 1 = own device, 2 = shared with this account, 3 = group.
    if (item.itemType !== 1 && item.itemType !== 2) continue;
    const d = item.itemData || {};
    const switches = Array.isArray(d.params?.switches) ? d.params.switches : [];
    devices.push({
      id: String(d.deviceid),
      name: String(d.name || d.deviceid),
      online: !!d.online,
      outlets: switches.map((s: any) => Number(s.outlet)).filter((n: number) => Number.isInteger(n)),
    });
  }
  return devices;
}

/**
 * Turns the chosen relay on. Gate relays are normally set to "inching" in the
 * eWeLink app, so "on" pulses the gate and the relay switches itself off.
 */
export async function switchOn(
  cfg: EwelinkConfig,
  tokens: EwelinkTokens,
  deviceId: string,
  outlet: number | null,
): Promise<void> {
  const params = outlet === null ? { switch: "on" } : { switches: [{ switch: "on", outlet }] };
  await call(cfg, tokens.region, "POST", "/v2/device/thing/status", {
    body: { type: 1, id: deviceId, params },
    accessToken: tokens.accessToken,
  });
}
