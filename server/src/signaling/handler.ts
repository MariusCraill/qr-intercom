import { WebSocketServer, WebSocket } from "ws";
import type { Server as NetServer } from "net";
import { v4 as uuid } from "uuid";
import type { SignalingMessage, WebSocketSession } from "../types.js";

export class SignalingServer {
  private sessions = new Map<string, WebSocketSession>();
  private wssList: WebSocketServer[] = [];

  constructor(...servers: NetServer[]) {
    for (const server of servers) {
      this.attach(server);
    }
  }

  attach(server: NetServer): void {
    const wss = new WebSocketServer({ server: server as never, path: "/ws" });
    this.wssList.push(wss);

    wss.on("connection", (ws, req) => {
      const sessionId = uuid();
      console.log(`[WS] New connection from ${req.socket.remoteAddress} (url=${req.url})`);
      const session: WebSocketSession = {
        ws,
        id: sessionId,
        role: "visitor",
        registeredAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
      console.log(`[WS] Client connected: ${sessionId}`);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          this.handleBinary(session, raw as Buffer);
          return;
        }
        try {
          const msg: SignalingMessage = JSON.parse(raw.toString());
          this.handleMessage(session, msg);
        } catch (err) {
          console.error(`[WS] Invalid message from ${sessionId}:`, err);
          this.send(ws, { type: "error", payload: "Invalid message format" });
        }
      });

      ws.on("close", (code) => {
        console.log(`[WS] Client disconnected: ${sessionId} code=${code}`);
        this.handleDisconnect(session);
        this.sessions.delete(sessionId);
      });

      ws.on("error", (err) => {
        console.error(`[WS] Error for ${sessionId}:`, err.message);
      });

      this.send(ws, { type: "welcome", payload: { sessionId } } as any);
    });
  }

  private handleBinary(sender: WebSocketSession, data: Buffer): void {
    if (!sender.callPeerId) return;
    const peer = this.sessions.get(sender.callPeerId);
    if (peer && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(data);
    }
  }

  private handleMessage(sender: WebSocketSession, msg: SignalingMessage): void {
    switch (msg.type) {
      case "register": {
        sender.role = msg.payload as "visitor" | "resident";
        if (msg.residentId) sender.residentId = msg.residentId;
        // Drop any stale/zombie session claiming the same role+residentId so the
        // app's reconnect churn never leaves duplicate resident sessions behind.
        if (sender.role === "resident" && sender.residentId) {
          const dupes = Array.from(this.sessions.values()).filter(
            (s) => s.id !== sender.id && s.role === "resident" && s.residentId === sender.residentId
          );
          for (const d of dupes) {
            console.log(`[WS] Replacing stale ${d.role} session ${d.id} for residentId=${d.residentId}`);
            this.clearCallPeer(d);
            try { d.ws.close(); } catch (e) {}
            this.sessions.delete(d.id);
          }
        }
        console.log(`[WS] Session ${sender.id} registered as ${sender.role} (residentId=${sender.residentId || "none"})`);
        this.send(sender.ws, { type: "registered", payload: { sessionId: sender.id } } as any);
        break;
      }

      case "call-request": {
        const targetResidentId = msg.residentId;
        console.log(`[WS] Call request from ${sender.id} to resident ${targetResidentId}`);
        console.log(`[WS] Active sessions: ${Array.from(this.sessions.values()).map(s => `${s.id}(${s.role}:${s.residentId})`).join(", ")}`);
        sender.targetResidentId = targetResidentId;
        const targets = this.findResidentSessions(targetResidentId);
        if (targets.length === 0) {
          console.log(`[WS] Resident ${targetResidentId} NOT FOUND`);
          this.send(sender.ws, {
            type: "call-unavailable",
            payload: { residentId: targetResidentId },
          } as any);
          return;
        }
        for (const target of targets) {
          console.log(`[WS] Forwarding call to session ${target.id}`);
          this.send(target.ws, {
            type: "call-request",
            from: sender.id,
            payload: msg.payload,
          } as any);
        }
        break;
      }

      case "call-accepted": {
        const visitor = this.sessions.get(msg.to || "");
        if (visitor) {
          this.send(visitor.ws, {
            type: "call-accepted",
            from: sender.id,
            payload: msg.payload,
          } as any);
          visitor.callPeerId = sender.id;
          sender.callPeerId = visitor.id;
          console.log(`[WS] Call paired: visitor=${visitor.id} <-> resident=${sender.id}`);
        }
        if (sender.residentId) {
          const others = this.findResidentSessions(sender.residentId)
            .filter((s) => s.id !== sender.id);
          for (const other of others) {
            console.log(`[WS] Notifying other resident session ${other.id} of call-accepted`);
            this.send(other.ws, {
              type: "call-ended",
              from: sender.id,
            } as any);
          }
        }
        break;
      }

      case "call-declined": {
        const visitorToDecline = this.sessions.get(msg.to || "");
        if (visitorToDecline) {
          this.send(visitorToDecline.ws, {
            type: "call-declined",
            from: sender.id,
          } as any);
        }
        if (sender.residentId) {
          const others = this.findResidentSessions(sender.residentId)
            .filter((s) => s.id !== sender.id);
          for (const other of others) {
            console.log(`[WS] Notifying other resident session ${other.id} of call-declined`);
            this.send(other.ws, {
              type: "call-declined",
              from: sender.id,
            } as any);
          }
        }
        break;
      }

      case "offer": {
        const offerTarget = this.sessions.get(msg.to || "");
        if (offerTarget) {
          this.send(offerTarget.ws, {
            type: "offer",
            from: sender.id,
            payload: msg.payload,
          } as any);
          console.log(`[WS] offer relayed ${sender.id} -> ${offerTarget.id}`);
        } else {
          console.warn(`[WS] offer: target ${msg.to} not found`);
        }
        break;
      }

      case "answer": {
        const answerTarget = this.sessions.get(msg.to || "");
        if (answerTarget) {
          this.send(answerTarget.ws, {
            type: "answer",
            from: sender.id,
            payload: msg.payload,
          } as any);
          console.log(`[WS] answer relayed ${sender.id} -> ${answerTarget.id}`);
        } else {
          console.warn(`[WS] answer: target ${msg.to} not found`);
        }
        break;
      }

      case "ice-candidate": {
        const iceTarget = this.sessions.get(msg.to || "");
        if (iceTarget) {
          this.send(iceTarget.ws, {
            type: "ice-candidate",
            from: sender.id,
            payload: msg.payload,
          } as any);
          if (this.clientCount < 50) {
            console.log(`[WS] ice-candidate relayed ${sender.id} -> ${iceTarget.id}`);
          }
        } else {
          console.warn(`[WS] ice-candidate: target ${msg.to} not found`);
        }
        break;
      }

      case "call-ended": {
        const endTarget = this.sessions.get(msg.to || "");
        if (endTarget) {
          this.send(endTarget.ws, { type: "call-ended", from: sender.id } as any);
          this.clearCallPeer(endTarget);
        }
        this.clearCallPeer(sender);
        if (sender.residentId) {
          const others = this.findResidentSessions(sender.residentId)
            .filter((s) => s.id !== sender.id);
          for (const other of others) {
            this.send(other.ws, { type: "call-ended", from: sender.id } as any);
          }
        }
        break;
      }

      default:
        console.warn(`[WS] Unknown message type from ${sender.id}: ${(msg as any).type}`);
    }
  }

  private clearCallPeer(session: WebSocketSession): void {
    if (session.callPeerId) {
      const peer = this.sessions.get(session.callPeerId);
      if (peer) peer.callPeerId = undefined;
      session.callPeerId = undefined;
    }
  }

  private handleDisconnect(session: WebSocketSession): void {
    if (session.callPeerId) {
      const peer = this.sessions.get(session.callPeerId);
      if (peer) {
        this.send(peer.ws, { type: "call-ended", from: session.id } as any);
        peer.callPeerId = undefined;
      }
      session.callPeerId = undefined;
    }
    if (session.role === "resident" && session.residentId) {
      for (const [, s] of this.sessions) {
        if (s.role === "visitor" && s.targetResidentId === session.residentId) {
          this.send(s.ws, { type: "call-ended", from: session.id } as any);
        }
      }
    }
  }

  private findResidentSessions(residentId?: string): WebSocketSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.role === "resident" && s.residentId === residentId
    );
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private get clientCount(): number {
    return this.wssList.reduce((count, wss) => count + wss.clients.size, 0);
  }

  /** True while one of this resident's sessions is paired with a visitor. */
  isResidentInCall(residentId: string): boolean {
    return this.findResidentSessions(residentId).some(
      (s) => !!s.callPeerId && this.sessions.has(s.callPeerId),
    );
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
