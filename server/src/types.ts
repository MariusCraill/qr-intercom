import type { WebSocket } from "ws";

// ── Database Models ──────────────────────────────────────────────────
export interface Resident {
  id: string;
  unit: string;
  name: string;
  phone: string;
  password_hash: string;
  email?: string | null;
  push_endpoint?: string;
  push_keys?: string;
  created_at: string;
}

export interface CallLog {
  id: string;
  visitor_session_id?: string | null;
  resident_id: string;
  started_at: string;
  ended_at?: string;
  accepted: boolean;
  unlocked: boolean;
}

// ── WebRTC Signaling Messages ────────────────────────────────────────
export type SignalingMessageType =
  | "register"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "call-request"
  | "call-accepted"
  | "call-declined"
  | "call-ended";

export interface SignalingMessage {
  type: SignalingMessageType;
  from: string;
  to?: string;
  payload?: unknown;
  residentId?: string;
}

// ── WebSocket Session ────────────────────────────────────────────────
export interface WebSocketSession {
  ws: WebSocket;
  id: string;
  role: "visitor" | "resident";
  residentId?: string;
  targetResidentId?: string;
  callPeerId?: string;
  registeredAt: number;
}
