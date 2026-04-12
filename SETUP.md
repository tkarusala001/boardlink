# BoardLink — Setup & Deployment Guide

## Prerequisites

- **Node.js** 20 or later — [Download](https://nodejs.org/)
- **npm** (bundled with Node.js)

---

## Quick Start (Local Development)

```bash
# 1. Install dependencies for root, server, and client
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..

# 2. Start both server and client in dev mode
npm run dev
```

This runs:
- **Signaling server** on `http://localhost:8082` (WebSocket + HTTP)
- **Vite dev server** on `http://localhost:5173` (with WebSocket proxy to the signaling server)

Open `http://localhost:5173` in your browser.

> **Note:** The Vite dev server proxies WebSocket connections to the signaling server automatically, so the client connects to `ws://localhost:5173` which gets forwarded to `ws://localhost:8082`. This matches the production behavior where everything runs on one origin.

---

## Project Structure

```
boardlink/
├── client/                  # Frontend (Vite + vanilla JS)
│   ├── src/
│   │   ├── main.js          # App entry point
│   │   ├── signaling.js     # WebSocket signaling client
│   │   ├── webrtc.js        # WebRTC peer connection manager
│   │   ├── style.css        # Styles (dark theme, WCAG compliant)
│   │   ├── ui/              # UI components (CursorGlow, FocusPane, PipHold)
│   │   └── workers/         # Web workers (processing, focus detection)
│   ├── __tests__/           # Client unit tests
│   ├── index.html           # SPA entry
│   ├── vite.config.js       # Dev proxy configuration
│   └── vercel.json          # Vercel deployment config (alternative)
│
├── server/                  # Backend (Node.js WebSocket server)
│   ├── index.js             # HTTP + WebSocket server (exports createServer())
│   ├── __tests__/           # Server unit + integration tests
│   └── package.json
│
├── Dockerfile               # Unified container (builds client + runs server)
├── fly.toml                 # Fly.io deployment config
└── SETUP.md                 # This file
```

---

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `8082`  | HTTP + WebSocket server port |

### Client (Build-time)

| Variable       | Default        | Description |
|----------------|----------------|-------------|
| `VITE_WS_URL`  | *(auto-detect)* | WebSocket URL override. If not set, the client derives it from the current page origin (`wss://yourdomain.com` or `ws://localhost:PORT`). Only needed for split client/server deployments. |

---

## Running Tests

### Server Tests

```bash
cd server
npm test
```

Runs with `--experimental-vm-modules` for ESM support. Tests include:
- **Validation** — Zod schema tests for message/room code format
- **Room management** — GC sweep, abandoned/stale detection
- **Integration** — Full WebSocket lifecycle (create room, join, rejoin, rate limiting, health endpoint)

### Client Tests

```bash
cd client
npm test
```

Tests include:
- **Focus worker** — Heatmap, signal fusion, region extraction
- **Signaling client** — Message queuing, reconnection backoff, protocol versioning
- **WebRTC client** — ICE config, peer lifecycle, offer/answer handling, cursor forwarding

### All Tests (from root)

```bash
cd server && npm test && cd ../client && npm test
```

---

## Production Deployment

### Option A: Fly.io (Recommended)

The project includes a `Dockerfile` and `fly.toml` for one-command deployment.

```bash
# Install Fly CLI: https://fly.io/docs/getting-started/installing-flyctl/
fly launch    # First time only
fly deploy    # Deploy updates
```

The Docker build:
1. Builds the client SPA (`client/dist/`)
2. Installs server production dependencies
3. Runs a single Node.js process that serves both the SPA and WebSocket

**What you get:** `https://boardlink.fly.dev` serves the UI and handles WebSocket signaling on the same origin. No CORS issues, no mixed-content warnings.

### Option B: Generic Docker

```bash
# Build
docker build -t boardlink .

# Run
docker run -p 8082:8082 boardlink

# With custom port
docker run -e PORT=3000 -p 3000:3000 boardlink
```

Open `http://localhost:8082` (or your custom port).

### Option C: Manual Production Build

```bash
# 1. Build the client
cd client
npm run build
cd ..

# 2. Install server production deps
cd server
npm ci --omit=dev

# 3. Start
PORT=8082 node index.js
```

The server will:
- Serve the built SPA from `client/dist/`
- Handle WebSocket connections for signaling
- Expose `/health` for monitoring

### Option D: Split Deployment (Vercel client + separate server)

If you prefer hosting the client on Vercel and the server elsewhere:

```bash
# Deploy client to Vercel
cd client
VITE_WS_URL=wss://your-server.fly.dev npm run build
# Then deploy dist/ to Vercel (vercel.json is pre-configured)

# Deploy server to Fly.io (or any host)
fly deploy
```

Set `VITE_WS_URL` at build time to point the client at your server's WebSocket endpoint.

---

## WebRTC & Firewalls

BoardLink uses WebRTC for screen sharing. By default it uses Google's free STUN servers, which work for most networks. If students are behind restrictive firewalls (some school networks), you may need a **TURN server**.

### Adding TURN Servers

Pass a custom ICE configuration when creating the WebRTC client. The `WebRTCClient` constructor accepts an optional `iceConfig` parameter:

```js
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'your-username',
      credential: 'your-password'
    }
  ]
};
```

For self-hosted TURN, [coturn](https://github.com/coturn/coturn) is the standard open-source option.

---

## Health Check

The server exposes `GET /health` which returns:

```json
{
  "status": "ok",
  "rooms": 3,
  "uptime": 1234.56
}
```

Used by Fly.io for auto-restart on failure. You can also use it for external monitoring.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **"Cannot reach signaling server"** | Ensure the server is running. In dev, run `npm run dev` from the root. |
| **WebSocket connection refused** | Check that `PORT` matches between server and client. In dev, the Vite proxy handles this automatically. |
| **Screen share doesn't start** | `getDisplayMedia` requires HTTPS or localhost. Ensure you're on `https://` in production. |
| **ICE connection fails** | Network may block peer-to-peer. Add a TURN server (see above). |
| **"Protocol version mismatch"** | Client and server are out of sync. Rebuild the client (`npm run build`). |
