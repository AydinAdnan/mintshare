## Plan: Production P2P File Share

Build a two-part system: a React + Vite web client for sender/receiver flows and a minimal signaling backend for room setup, SDP/ICE exchange, and room lifecycle only. Use WebRTC data channels for file payloads, WebSocket signaling for setup, optional TURN for NAT traversal, and app-level encryption on top of WebRTC to protect both file bytes and metadata. Recommended stack change from your initial idea: prefer Node.js + ws for signaling over Express + Socket.IO because signaling traffic is tiny and performance-sensitive, though Express + Socket.IO remains acceptable if faster delivery for the first version matters more than backend minimalism.

**Steps**
1. Phase 1 - Foundation and architecture: set up a monorepo with separate frontend, signaling, and shared protocol packages; define role-based app routes (send / receive); define the message schema for signaling, control-channel messages, and transfer state events. This phase blocks all later work.
2. Phase 1 - Define transport contract: model rooms, peer roles, session expiry, 6-character human-safe join codes, QR payload format, manifest schema, per-file lifecycle messages, progress events, resume/abort messages, and integrity/hash metadata. This phase blocks WebRTC and UI work.
3. Phase 1 - Security baseline: require HTTPS/WSS, CSP, HSTS, rate limiting, schema validation, room TTL cleanup, and log redaction; decide that files are never persisted server-side, while TURN may relay encrypted packets when direct P2P fails. This phase blocks deployment hardening but can run in parallel with Phase 2 once message contracts are fixed.
4. Phase 2 - Signaling backend: implement a lightweight WebSocket service with ephemeral in-memory room state, sender/receiver pairing, SDP offer/answer relay, ICE candidate relay, join-code collision handling, room expiry, heartbeats, and disconnect cleanup; add optional Redis adapter only if multi-instance scaling is required. This depends on steps 1-2.
5. Phase 2 - WebRTC connection manager: build a browser connection layer around RTCPeerConnection with one reliable ordered control channel and one bulk data channel optimized for throughput; configure STUN and TURN; implement connection state monitoring, ICE restart, and reconnect windows. This depends on steps 1-2 and can run in parallel with step 4 after protocols are fixed.
6. Phase 3 - Transfer engine: implement file and directory selection, recursive directory traversal via File System Access API when available, manifest exchange, adaptive chunking, bufferedAmount-based backpressure, per-file queue scheduling, rolling transfer stats, speed smoothing, ETA calculation, pause/cancel, integrity verification, and completion events. Use sequential transfer with pipelining by default because it is more stable than true simultaneous file streaming over a single SCTP transport, while still supporting multiple selected files in one session. This depends on steps 4-5.
7. Phase 3 - Encryption layer: use Web Crypto API with AES-GCM for manifest and chunk encryption; derive a session key from an ECDH exchange over the already-secure WebRTC session or from a QR-embedded secret for stronger out-of-band verification; keep DTLS from WebRTC as the transport baseline. This depends on steps 2 and 5.
8. Phase 4 - Frontend product flows: implement the sender flow (select files/directories, generate code, show QR, wait for receiver, transfer dashboard) and receiver flow (join by code or QR, accept transfer, see live per-file and aggregate progress, download individual files, or download-all zip preserving folder structure). Use a state machine to model idle, pairing, connecting, ready, transferring, recovering, completed, and error states. This depends on steps 4-7.
9. Phase 4 - Download packaging: store received chunks efficiently, reconstruct files as Blob objects, expose individual downloads immediately on completion, and generate the download-all archive in a Web Worker to avoid blocking the UI. Preserve folder structure in the archive and provide a clear warning when very large zip generation may be memory-heavy. This depends on step 6 and can run in parallel with most of step 8.
10. Phase 4 - Three.js experience layer: add a lightweight animated background or transfer scene that reflects pairing and transfer state without competing with the functional UI; lazy-load the scene, cap frame rate, pause on hidden tabs or constrained devices, and disable expensive effects during heavy transfers. This depends on step 8 and should not block core transfer capability.
11. Phase 5 - Reliability and recovery: add preflight checks, browser capability detection, graceful fallback messaging, resend / retry behaviors, hash mismatch handling, stalled-transfer detection, optional ICE restart, duplicate filename handling, and clear receiver-side recovery UX. This depends on steps 6-9.
12. Phase 5 - Observability and abuse controls: add structured telemetry for room creation, join success rate, direct-vs-relayed connection ratio, transfer completion rate, average throughput, and failure taxonomy; add rate limits, payload-size caps, schema validation, and room-level anti-enumeration protections. This depends on steps 3-5.
13. Phase 6 - Production delivery: package the frontend with Vite, containerize the signaling server, provision HTTPS and TURN, configure health checks and autoscaling, document local and production environments, and prepare CI with lint, typecheck, unit tests, and end-to-end browser tests. This depends on all prior phases.

**Relevant files**
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\package.json - workspace scripts, package manager, monorepo orchestration.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\pnpm-workspace.yaml - workspace layout for frontend, signaling, and shared packages.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\package.json - React + Vite app dependencies and scripts.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\app\state\transferMachine.ts - source of truth for sender/receiver state transitions.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\signaling\signalingClient.ts - WebSocket client for room lifecycle and SDP/ICE exchange.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\rtc\peerConnection.ts - RTCPeerConnection setup, channels, ICE handling, reconnect logic.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\transfer\transferEngine.ts - chunk scheduler, backpressure, stats, retry, and integrity checks.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\transfer\fileManifest.ts - manifest creation and folder-structure preservation.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\crypto\sessionCrypto.ts - app-layer key management and AES-GCM helpers.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\downloads\zipWorker.ts - worker-based zip generation and progress reporting.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\ui\pages - sender, receiver, transfer, completion, and recovery screens.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\web\src\features\ui\three\TransferScene.tsx - lazy-loaded Three.js scene tied to transfer state.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\signal\package.json - signaling service dependencies and scripts.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\signal\src\server.ts - WSS bootstrap, room store, and connection lifecycle.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\signal\src\rooms\roomManager.ts - join-code allocation, expiry, anti-enumeration, and cleanup.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\signal\src\validation\messages.ts - schema validation for all inbound signaling payloads.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\apps\signal\src\security\rateLimit.ts - IP and connection-level rate limiting.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\packages\protocol\src\index.ts - shared types for signaling, control messages, manifests, and transfer stats.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\infra\docker-compose.yml - local app plus coturn for integration testing.
- c:\Users\aydin\OneDrive\Desktop\CodeFiles\FileSharing\README.md - architecture, setup, security notes, and operating limits.

**Verification**
1. Unit-test the shared protocol, chunk framing, hash verification, room lifecycle, and rate-limit behavior.
2. Browser-test sender and receiver flows in Chromium, Firefox, Safari, and Edge with both direct STUN and relayed TURN paths.
3. Validate multi-file sessions including nested directories, duplicate filenames, cancellation, interrupted transfers, and zip generation with preserved folder structure.
4. Stress-test large files and mixed file batches to verify bufferedAmount backpressure, stable memory usage, UI responsiveness, and accurate speed / ETA reporting.
5. Run security checks for CSP, HTTPS-only transport, WSS-only signaling, schema validation, room expiration, replay resistance, and absence of server-side file persistence.
6. Capture connection and transfer telemetry in staging to confirm room pairing success, NAT traversal success rates, and failure reasons before launch.

**Decisions**
- Include: two-user sessions, multi-file support, optional directory support, QR and short-code join, live progress, per-file downloads, download-all zip, and production observability.
- Include: TURN as an allowed encrypted relay for connectivity; the server still does not persist files, but encrypted packets may traverse the relay when direct P2P is impossible.
- Exclude from initial scope: resumable transfers across full page reloads, background service-worker transfers, multi-recipient rooms, account systems, server-side storage, and native desktop wrappers.
- Constraint: "No file size limits" can be honored at the product-policy level, but practical browser/device limits still exist due to memory, storage, battery, and relay bandwidth; the implementation should avoid artificial caps while surfacing device-related failure states clearly.
- Recommendation: prefer ws over Socket.IO for the production signaling service; keep Express + Socket.IO only if team familiarity and delivery speed outweigh the extra abstraction.
- Recommendation: default to a single active data stream with multiple selected files queued and pipelined, because this is more reliable than true parallel large-file streaming over one peer connection while still satisfying the user-facing requirement to send multiple files in one session.

**Further Considerations**
1. If you want stricter out-of-band trust, derive or embed an extra secret in the QR code so that scanning the QR both joins the room and confirms the encryption context, reducing the risk of code guessing.
2. If you expect enterprise-network users, treat TURN as mandatory infrastructure rather than optional, and budget for relay bandwidth because some transfers will be fully relayed.
3. If Safari mobile support is a hard requirement from day one, keep the first release conservative on directory APIs, background behavior, and worker-heavy zip generation because Safari is the browser most likely to force edge-case compromises.
