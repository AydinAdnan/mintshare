# File Sharing

Browser-to-browser file sharing built with JavaScript, React, Vite, WebRTC data channels, and a lightweight Node.js `ws` signaling server.

## What MintShare uses

### Core technologies

- `React` for the sender and receiver user interface
- `Vite` for fast local development and production bundling
- `Node.js` for the signaling backend runtime
- `ws` for persistent WebSocket signaling between browser and server
- `WebRTC` for the direct browser-to-browser connection
- `Three.js` for the lightweight animated visual layer
- `JSZip` for receiver-side zip generation in the browser
- `Zod` in `packages/protocol` to validate shared control-message formats

### Network protocols and what they do

- `HTTPS` serves the frontend securely in production
- `WebSocket` carries room creation, join, offer, answer, and ICE-candidate signaling messages
- `WebRTC` creates the actual peer-to-peer transport between the two browsers
- `ICE` finds a working network path between sender and receiver
- `STUN` helps each browser discover its public-facing network address
- `TURN` relays traffic when direct peer-to-peer connectivity is blocked by NATs, firewalls, mobile networks, or restrictive Wi-Fi
- `DTLS` encrypts the WebRTC transport in transit
- `SCTP` runs underneath the WebRTC data channel and provides reliable ordered delivery for file bytes

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

## How it works

### High-level flow

1. The sender selects one or more files in the web app.
2. The app opens a WebSocket connection to the signaling server and creates a six-character room code.
3. The receiver joins with the code or QR link.
4. The signaling server only coordinates setup. It does not store the files.
5. The two browsers exchange WebRTC offer, answer, and ICE-candidate messages over WebSocket.
6. Once the WebRTC connection is ready, the sender shares a transfer manifest listing file metadata.
7. The receiver explicitly chooses which files to accept.
8. Only the approved files are streamed over the WebRTC file data channel in chunks.
9. The receiver reconstructs files locally in memory and can either download individual files or generate a zip archive in the browser.

### Data-path model

- `Signaling path`: browser -> WebSocket server -> browser
- `File path`: browser -> WebRTC data channel -> browser

This separation matters because the signaling server is only used to establish the connection. After pairing, the file bytes go directly between devices unless a TURN relay is needed.

### Transfer behavior

- Files are sent sequentially for better stability over a single reliable data channel.
- Each file is split into `256 KB` chunks by default.
- Backpressure is controlled through the data channel buffered-amount threshold to avoid overwhelming the browser.
- Progress, throughput, and ETA are calculated live on the client.
- Downloads are manual only. Nothing auto-downloads on receipt.

## Architecture

### Frontend

- `apps/web` contains the React app.
- The sender and receiver flows live in the same app and switch by UI state.
- The app manages room setup, WebRTC negotiation, file manifests, transfer progress, and manual downloads.

### Signaling server

- `apps/signal` hosts a lightweight WebSocket server.
- It manages room creation, room joins, and forwarding of signaling messages.
- It includes payload limits, origin allowlisting, and heartbeat cleanup for production use.

### Shared protocol package

- `packages/protocol` defines the control-message schema shared across the app.
- This reduces protocol drift between frontend behavior and signaling expectations.

## How good it is

### Where MintShare is strong

- Very efficient for browser-based file transfer because file bytes do not pass through your app server in the normal case.
- Fast on local or well-connected networks because WebRTC data channels avoid extra upload-download hops through central storage.
- Good privacy characteristics compared with server-stored file sharing because the server coordinates pairing rather than holding the content.
- Works well for ad hoc transfers between desktop browsers and between mixed devices when TURN is configured correctly.
- Lightweight operational model because the backend is only a signaling service, not a file-hosting platform.

### Practical limits

- Reliability across mobile networks or enterprise Wi-Fi depends heavily on TURN availability.
- Large transfers are constrained by browser memory because received files and zip generation are currently handled client-side.
- This is a live-session transfer tool, not a persistent cloud-storage system.
- If either browser tab closes or the connection drops, the transfer does not resume automatically.
- The current implementation is optimized for one sender and one receiver per room.

### Realistic assessment

- For direct browser-based transfer, this is a strong architecture: simple, fast, and cost-efficient.
- For production, it is good if you provide stable TURN infrastructure and host the signaling server on a WebSocket-friendly platform.
- For very large files, resumability, auditability, or enterprise-grade control, it would still need additional hardening beyond the current baseline.

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

This repository includes Vercel config for both common setups:

- repository root project: root `vercel.json` publishes `apps/web/dist`
- `apps/web` root project: `apps/web/vercel.json` publishes `dist`

In Vercel:

1. Import the repository.
2. Either keep the project root at the repository root or set the Root Directory to `apps/web`.
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

For a full production guide, including managed TURN and self-hosted coturn options, see [TURN_SETUP.md](TURN_SETUP.md).

## Production defaults

The frontend now uses production-oriented transport defaults:

- `VITE_CHUNK_SIZE_BYTES=262144` for 256 KB file chunks
- `VITE_MAX_BUFFERED_AMOUNT_BYTES=8388608` for 8 MB data-channel backpressure threshold

The signaling server also supports these production controls:

- `ALLOWED_ORIGINS` as a comma-separated allowlist of browser origins
- `MAX_WS_PAYLOAD_BYTES` to cap incoming WebSocket payload size
- `HEARTBEAT_INTERVAL_MS` for dead-connection cleanup

Example:

```bash
ALLOWED_ORIGINS=https://your-vercel-app.vercel.app,https://mintshare.example.com
MAX_WS_PAYLOAD_BYTES=65536
HEARTBEAT_INTERVAL_MS=30000
```

## Notes

- WebRTC encrypts transport in transit with DTLS.
- The current implementation is a functional JavaScript baseline. App-layer encryption, resumable transfers, stronger abuse controls, and worker-based zip generation remain next-step hardening tasks.
- The frontend bundle intentionally lazy-loads Three.js and JSZip paths to keep the main route smaller.
