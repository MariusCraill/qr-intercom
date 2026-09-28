# QR Video Intercom & Remote Gate Trigger

A complete web-based intercom system with WebRTC video/audio, MQTT-driven gate control, and ESP32 relay firmware.

## Architecture

```
┌──────────────┐     WebRTC      ┌──────────────────┐
│   Visitor     │◄───(video/aud)─►│   Resident PWA   │
│   Browser     │                 │   (Mobile App)   │
└──────┬───────┘                 └──────┬───────────┘
       │                                │
       │ REST + WS                      │ REST + WS
       ▼                                ▼
┌──────────────────────────────────────────────┐
│              API Server (Node.js)            │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  │
│  │ Express  │  │ WebSocket │  │ MQTT     │  │
│  │ REST API │  │ Signaling │  │ Client   │  │
│  └──────────┘  └───────────┘  └────┬─────┘  │
│                                    │         │
│  ┌──────────┐  ┌───────────┐      │         │
│  │ SQLite   │  │ JWT Auth  │      │         │
│  └──────────┘  └───────────┘      │         │
└───────────────────────────────────┼─────────┘
                                    │ MQTT
                                    ▼
                         ┌──────────────────┐
                         │   ESP32 Relay     │
                         │   (Gate Controller)│
                         └──────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+
- MQTT broker (Mosquitto) — required for gate unlock; the video intercom works without it
- PlatformIO CLI (for ESP32 firmware)

### 1. Start MQTT Broker

```bash
docker compose up -d
```

### 2. Start API Server

```bash
cd server
npm install
cp .env.example .env     # then set JWT_SECRET to a random value
npm run db:migrate       # bring an existing database onto the current schema
npm run build && npm start
```

> **Do not run `npm run db:seed` against a database with real accounts.** It
> drops and recreates the `residents`, `admins` and `call_logs` tables, so it
> destroys all existing data. It now refuses to run unless you pass
> `--force`, and is only appropriate for a brand-new database.
> Use `npm run db:migrate` to move an existing database — that one preserves
> every row.

The server listens on two ports, and both matter:

| Port | Default | Purpose |
|------|---------|---------|
| `HTTP_PORT` | 3010 | Plain HTTP. **This is what the Tailscale Funnel proxies to.** |
| `PORT` | 3011 | Direct LAN HTTPS/WSS. Optional; the server runs HTTP-only if the certs are missing. |

`HTTP_PORT` must match your `tailscale funnel status` config, which maps
`/api`, `/ws`, `/admin`, `/visit` and `/resident` onto it. If they disagree the
funnel returns 502 for everything.

On Windows, `start-intercom.cmd` starts the server with the right working
directory and supervises it across crashes; a Scheduled Task named
**QR Intercom Server** runs it at logon.

### 3. Start Visitor Frontend

```bash
cd client-visitor
npm install
npm run dev
```

Served at `http://localhost:5173` — visit `/gate/<gate-uuid>`.

### 4. Start Resident Frontend

```bash
cd client-resident
npm install
npm run dev
```

Served at `http://localhost:5174`.

### 5. Flash ESP32

Edit `firmware/intercom_gate/config.h` with your Wi-Fi credentials, MQTT broker IP, gate UUID, and HMAC secret. Then:

```bash
cd firmware
pio run -t upload
```

## Demo Flow

1. **Visitor scans QR code** → Opens `/gate/<gateId>`, sees resident directory
2. **Visitor searches & calls** → Picks a resident, WebRTC camera activates
3. **Resident receives notification** → Accept audio or decline
4. **Resident unlocks gate** → JWT-signed request hits API → MQTT publish → ESP32 pulses relay

## Seeded Demo Credentials

After `npm run db:seed`, these residents exist (password: `password123`):

| Email              | Name        | Unit |
|--------------------|-------------|------|
| alice@example.com  | Alice Chen  | 101  |
| bob@example.com    | Bob Patel   | 102  |
| carol@example.com  | Carol Zhang | 201  |
| david@example.com  | David Kim   | 202  |
| eve@example.com    | Eve Johnson | 301  |

## Project Structure

```
qr-intercom/
├── server/                 # API + WebSocket + MQTT backend
│   └── src/
│       ├── index.ts        # Entry point
│       ├── config/         # Environment config
│       ├── db/             # SQLite schema + migrations
│       ├── auth/           # JWT sign/verify + middleware
│       ├── routes/         # REST endpoints
│       ├── mqtt/           # MQTT client + unlock dispatch
│       └── signaling/      # WebRTC signaling (WebSocket)
├── client-visitor/         # Visitor web UI (Vite + vanilla JS)
├── client-resident/        # Resident PWA (Vite + vanilla JS)
├── firmware/               # ESP32 PlatformIO project
│   └── intercom_gate/
│       ├── config.h        # Wi-Fi, MQTT, GPIO config
│       ├── signature.h     # HMAC-SHA256 verification
│       ├── gpio_relay.h    # Relay pulse controller
│       ├── mqtt_handler.h  # MQTT subscription + dispatch
│       └── intercom_gate.ino  # Main firmware
├── docker-compose.yml      # Mosquitto MQTT broker
└── mosquitto/              # Broker configuration
```

## Security Model

- **JWT tokens** authenticate residents for unlock commands
- **HMAC-SHA256 signatures** verify MQTT payloads (shared secret between server + ESP32)
- **Timestamp-based replay protection** — commands expire after 30 seconds
- **Gate-scoped permissions** — residents can only unlock their assigned gate

## Production Hardening

- Replace SQLite with PostgreSQL
- Enable MQTT authentication (username/password + TLS)
- Add rate limiting to unlock endpoint
- Implement WebRTC TURN servers for NAT traversal
- Add TLS to all WebSocket connections
- Store HMAC secrets in hardware security modules
- Flash ESP32 with device-specific keys via provisioning
