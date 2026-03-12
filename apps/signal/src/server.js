import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { parseSignalMessage } from "@fileshare/protocol";

const port = Number(process.env.PORT || 3001);
const roomTtlMs = 10 * 60 * 1000;
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 30_000);
const maxPayloadBytes = Number(process.env.MAX_WS_PAYLOAD_BYTES || 64 * 1024);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

// Security limits
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP || 10);
const MAX_ROOMS_TOTAL = Number(process.env.MAX_ROOMS_TOTAL || 2000);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 3);
const JOIN_RATE_WINDOW_MS = 60_000;
const MAX_JOINS_PER_WINDOW = Number(process.env.MAX_JOINS_PER_WINDOW || 20);

// ip -> connection count
const connectionsPerIp = new Map();
// ip -> { count, windowStart }
const joinAttemptsPerIp = new Map();
// ip -> active room count
const roomsPerIp = new Map();

const rooms = new Map();
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function getIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return (forwarded ? forwarded.split(",")[0].trim() : null) || request.socket.remoteAddress || "unknown";
}

function trackConnect(ip) {
  connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
}

function trackDisconnect(ip) {
  const current = connectionsPerIp.get(ip) || 0;
  if (current <= 1) {
    connectionsPerIp.delete(ip);
  } else {
    connectionsPerIp.set(ip, current - 1);
  }
}

function isConnectionLimitExceeded(ip) {
  return (connectionsPerIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP;
}

function isJoinRateLimitExceeded(ip) {
  const now = Date.now();
  const entry = joinAttemptsPerIp.get(ip);
  if (!entry || now - entry.windowStart > JOIN_RATE_WINDOW_MS) {
    joinAttemptsPerIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_JOINS_PER_WINDOW;
}

function trackRoomCreated(ip) {
  roomsPerIp.set(ip, (roomsPerIp.get(ip) || 0) + 1);
}

function trackRoomRemoved(ip) {
  const current = roomsPerIp.get(ip) || 0;
  if (current <= 1) {
    roomsPerIp.delete(ip);
  } else {
    roomsPerIp.set(ip, current - 1);
  }
}

function isRoomLimitExceeded(ip) {
  return (roomsPerIp.get(ip) || 0) >= MAX_ROOMS_PER_IP;
}

function generateCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createRoom(senderSocket, creatorIp) {
  if (rooms.size >= MAX_ROOMS_TOTAL) return null;
  if (isRoomLimitExceeded(creatorIp)) return null;

  let code = generateCode();
  let attempts = 0;
  while (rooms.has(code)) {
    code = generateCode();
    attempts += 1;
    if (attempts > 100) return null;
  }

  const room = {
    code,
    createdAt: Date.now(),
    creatorIp,
    sender: senderSocket,
    receiver: null,
  };

  rooms.set(code, room);
  trackRoomCreated(creatorIp);
  return room;
}

function sendJson(socket, message) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

// Never expose internal error details to the client
function sendSafeError(socket, genericMessage) {
  sendJson(socket, { type: "room:error", payload: { message: genericMessage } });
}

function destroyRoom(code, reasonType = null) {
  const room = rooms.get(code);
  if (!room) return;

  if (reasonType) {
    sendJson(room.sender, { type: reasonType, payload: { code } });
    sendJson(room.receiver, { type: reasonType, payload: { code } });
  }

  trackRoomRemoved(room.creatorIp);
  rooms.delete(code);
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > roomTtlMs) {
      destroyRoom(code, "room:expired");
    }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: maxPayloadBytes,
  perMessageDeflate: false,
});

wss.on("connection", (socket, request) => {
  const origin = request.headers.origin;
  if (allowedOrigins.size > 0 && origin && !allowedOrigins.has(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }

  const ip = getIp(request);

  // Enforce per-IP connection limit
  if (isConnectionLimitExceeded(ip)) {
    socket.close(1008, "Too many connections");
    return;
  }
  trackConnect(ip);
  socket.clientIp = ip;

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    try {
      const message = parseSignalMessage(JSON.parse(raw.toString()));

      if (message.type === "room:create") {
        // Only allow room creation if no room already tied to this socket
        if (socket.roomCode) {
          sendSafeError(socket, "Already in a room");
          return;
        }
        const room = createRoom(socket, socket.clientIp);
        if (!room) {
          sendSafeError(socket, "Could not create room. Try again later.");
          return;
        }
        socket.roomCode = room.code;
        socket.role = "sender";
        sendJson(socket, { type: "room:created", payload: { code: room.code } });
        return;
      }

      if (message.type === "room:join") {
        // Rate-limit join attempts from this IP
        if (isJoinRateLimitExceeded(socket.clientIp)) {
          sendSafeError(socket, "Too many join attempts. Wait a moment and try again.");
          return;
        }

        const room = rooms.get(message.payload.code);
        if (!room || room.receiver) {
          sendSafeError(socket, "Room unavailable");
          return;
        }

        // Prevent self-join: sender cannot join their own room
        if (room.sender === socket) {
          sendSafeError(socket, "Room unavailable");
          return;
        }

        room.receiver = socket;
        socket.roomCode = room.code;
        socket.role = "receiver";
        sendJson(socket, { type: "room:joined", payload: { code: room.code } });
        sendJson(room.sender, { type: "room:ready", payload: { code: room.code } });
        return;
      }

      // All remaining messages must reference a room the socket is already in
      const room = rooms.get(socket.roomCode);
      if (!room || !socket.role) {
        sendSafeError(socket, "Room not found");
        return;
      }

      // Enforce role-based message direction:
      // only senders send offer/answer/ice-candidate after acting as initiator,
      // but both roles may send ice-candidates; reject messages targeting the wrong room code
      if (message.payload.code && message.payload.code !== socket.roomCode) {
        sendSafeError(socket, "Room mismatch");
        return;
      }

      const peer = socket === room.sender ? room.receiver : room.sender;
      if (!peer) {
        sendSafeError(socket, "Peer not connected");
        return;
      }

      sendJson(peer, message);
    } catch {
      // Never leak internal error details
      sendSafeError(socket, "Invalid message");
    }
  });

  socket.on("close", () => {
    trackDisconnect(socket.clientIp);

    if (!socket.roomCode) {
      return;
    }

    const room = rooms.get(socket.roomCode);
    if (!room) {
      return;
    }

    const peer = socket === room.sender ? room.receiver : room.sender;
    sendJson(peer, { type: "room:peer-left", payload: { code: room.code } });
    trackRoomRemoved(room.creatorIp);
    rooms.delete(room.code);
  });
});

const cleanupTimer = setInterval(cleanupExpiredRooms, 30 * 1000);
cleanupTimer.unref();

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) {
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    socket.ping();
  });
}, heartbeatIntervalMs);
heartbeatTimer.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`signaling server listening on http://0.0.0.0:${port}`);
});
