# File Sharing

Browser-to-browser file sharing built with JavaScript, React, Vite, WebRTC data channels, and a lightweight Node.js `ws` signaling server.

## Current implementation

- Six-character room code generation with QR join link
- Sender and receiver room flows over WebSocket signaling
- WebRTC peer negotiation with control and file data channels
- Multi-file selection plus folder selection via `webkitdirectory`
- Sequential chunked transfer with data-channel backpressure control
- Live connection state, transfer progress, speed, and ETA
- Individual receiver downloads per file
- Download-all zip generation in the browser
- Lightweight Three.js visual layer

## Workspace

- `apps/web` - React + Vite frontend
- `apps/signal` - Node.js signaling server using `ws`
- `packages/protocol` - shared message schemas and parsers

## Local development

1. Copy `.env.example` values into your environment if needed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start both apps:
   ```bash
   npm run dev
   ```
4. Open the frontend at `http://localhost:5173`.
5. Open the same app in a second browser or device to test sender and receiver flows.

## Separate commands

```bash
npm run dev:web
npm run dev:signal
npm run build
```

## Deploy

### Vercel frontend

The React app in `apps/web` can be deployed to Vercel.

This repository already includes a root `vercel.json` that builds the web workspace and publishes `apps/web/dist`.

The Vite build is configured to emit the production bundle to the repository root `dist` directory so Vercel can detect it consistently in this monorepo.

In Vercel:

1. Import the repository.
2. Keep the project root at the repository root.
3. Use the default install command or `npm install`.
4. Set the production environment variable `VITE_SIGNAL_URL` to your deployed signaling server, for example:

```bash
VITE_SIGNAL_URL=wss://signal.your-domain.com
```

5. Add TURN values if you need cross-network reliability:

```bash
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=example-user
VITE_TURN_CREDENTIAL=example-password
```

### Signaling server

The current signaling backend in `apps/signal` uses a long-lived `ws` WebSocket server. That is not a good fit for standard Vercel serverless deployment.

Deploy the signaling server separately on a host that supports persistent Node.js processes and WebSockets, such as Render, Railway, Fly.io, or a VPS.

#### Render setup

This repository includes a root `render.yaml` Blueprint for the signaling server.

If you use Render Blueprint deploy:

1. Push this repository to GitHub.
2. In Render, create a new Blueprint instance from the repository.
3. Render will create the `fileshare-signal` web service using the included `render.yaml`.
4. After deploy, copy the public service URL, for example:

```bash
https://fileshare-signal.onrender.com
```

5. Set your Vercel frontend environment variable to the WebSocket version of that URL:

```bash
VITE_SIGNAL_URL=wss://fileshare-signal.onrender.com
```

If you prefer manual Render setup instead of Blueprint, use these values:

- Environment: `Node`
- Root Directory: repository root
- Build Command: `npm install`
- Start Command: `npm run start --workspace @fileshare/signal`
- Health Check Path: `/health`

Minimal production start command:

```bash
npm install
npm run start --workspace @fileshare/signal
```

Set `PORT` from the hosting platform if required.

### Important

- Vercel hosts the frontend.
- A separate host runs the WebSocket signaling server.
- The frontend must point to the signaling host through `VITE_SIGNAL_URL`.
- STUN-only WebRTC works on many networks, but production use often needs TURN.

## TURN configuration

Direct peer-to-peer works on many networks with STUN only, but restrictive NATs and enterprise firewalls will require TURN. Supply the frontend with:

- `VITE_TURN_URLS` as a comma-separated list of TURN URLs
- `VITE_TURN_USERNAME`
- `VITE_TURN_CREDENTIAL`

Example:

```bash
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=example-user
VITE_TURN_CREDENTIAL=example-password
```

## Notes

- WebRTC encrypts transport in transit with DTLS.
- The current implementation is a functional JavaScript baseline. App-layer encryption, resumable transfers, stronger abuse controls, and worker-based zip generation remain next-step hardening tasks.
- The frontend bundle intentionally lazy-loads Three.js and JSZip paths to keep the main route smaller.
