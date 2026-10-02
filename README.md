# QR Video Intercom

A self-hosted video door-entry system. Residents scan a QR code at the gate, get
through on a WebRTC call to the dashboard, and the door is opened over MQTT.

Ships with a second component, `agent-app/` — a local personal assistant that
answers questions using your calendar, notes and uploaded documents.

## Contents

| Folder        | What it is                                                        |
| ------------- | ----------------------------------------------------------------- |
| `server/`     | Intercom server: dashboard, resident app, gate kiosk, WebRTC, MQTT |
| `agent-app/`  | Separate personal agent (LLM chat, documents, Microsoft Graph)     |
| `start.bat`   | Windows launcher that boots the intercom server and opens the UI  |

## Requirements

- Node.js 18 or newer
- An MQTT broker (defaults to `mqtt://localhost:1883`) if you use physical gates
- Windows, if you want to use `start.bat` (the server itself runs anywhere)

## Quick start

```bat
start.bat
```

The launcher installs dependencies, copies `.env.example` to `.env` on first run,
waits for the server to actually answer on its health endpoint, and then opens the
dashboard in your browser.

To run the two parts by hand instead:

```bash
cd server
npm install
copy .env.example .env    # then edit JWT_SECRET before real use
npm start
```

## Configuration

`server/.env` — all settings have working defaults in `.env.example`. The ones
worth knowing:

| Variable           | Default                 | Notes                                              |
| ------------------ | ----------------------- | -------------------------------------------------- |
| `PORT`             | `3100`                  | HTTP port                                           |
| `HTTPS_PORT`       | `3143`                  | **Use this for calls** — browsers block camera on plain HTTP other than localhost |
| `JWT_SECRET`       | `change-me-...`         | Generate a real one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `MQTT_BROKER`      | `mqtt://localhost:1883` | Broker URL, including credentials if required        |
| `DB_PATH`          | `C:/qr-intercom-data/…` | SQLite file                                         |
| `PUBLIC_BASE_URL`  | derived from request    | Set explicitly behind a proxy so QR codes point at the right host |
| `COOKIE_SECURE`    | `false`                 | Set `true` once HTTPS is your normal path            |

HTTPS uses a self-signed certificate generated on first boot and cached in
`.certs/`. Accept the warning once per device and camera/mic will work; the
warning does not come back after a server restart.

## Endpoints

| URL                        | Who       | What                                  |
| -------------------------- | --------- | ------------------------------------- |
| `/`                        | Operator  | Dashboard, call list, door controls   |
| `/resident/`               | Resident  | Answers calls on the phone            |
| `/call/<residentId>`       | Resident  | Link behind the QR code at the gate   |
| `/gate/<gateId>`           | Kiosk     | Gate terminal, shows QR code          |
| `/healthz`                 | Anyone    | Liveness check used by the launcher   |

## Security notes

This is built for a private LAN. Before exposing it to the internet:

- Set a real `JWT_SECRET`.
- Put it behind a reverse proxy with a trusted certificate instead of relying on
  the self-signed one.
- Set `COOKIE_SECURE=true` and narrow `CORS_ORIGIN` from `*`.
- Only the admin account may open doors — keep its password strong.

Secrets, databases, TLS keys and `node_modules/` are all excluded by
`.gitignore`. Only `.env.example` files are committed.

## agent-app

A separate local assistant, unrelated to the intercom. It binds to `127.0.0.1`
by default and is protected by an `AGENT_TOKEN`.

```bash
cd agent-app
npm install
copy .env.example .env    # set AGENT_TOKEN, then fill in your LLM provider
npm start
```

Works with any OpenAI-compatible provider — OpenAI, Ollama, LM Studio, or
Anthropic through a compatible proxy. Calendar and OneNote come from Microsoft
Graph and need an app registration in Entra ID; see the comments in
`agent-app/.env.example`. Uploaded documents are indexed for retrieval, and web
search is optional (DuckDuckGo needs no key, Tavily does).

## License

MIT
