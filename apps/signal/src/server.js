import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { parseSignalMessage } from "@fileshare/protocol";

const port = Number(process.env.PORT || 3001);
const roomTtlMs = 10 * 60 * 1000;
const rooms = new Map();
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function generateCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createRoom(senderSocket) {
  let code = generateCode();
  while (rooms.has(code)) {
    code = generateCode();
  }

  const room = {
    code,
    createdAt: Date.now(),
    sender: senderSocket,
    receiver: null,
  };

  rooms.set(code, room);
  return room;
}

function sendJson(socket, message) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > roomTtlMs) {
      sendJson(room.sender, { type: "room:expired", payload: { code } });
      sendJson(room.receiver, { type: "room:expired", payload: { code } });
      rooms.delete(code);
    }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const message = parseSignalMessage(JSON.parse(raw.toString()));

      if (message.type === "room:create") {
        const room = createRoom(socket);
        socket.roomCode = room.code;
        socket.role = "sender";
        sendJson(socket, { type: "room:created", payload: { code: room.code } });
        return;
      }

      if (message.type === "room:join") {
        const room = rooms.get(message.payload.code);
        if (!room || room.receiver) {
          sendJson(socket, { type: "room:error", payload: { message: "Room unavailable" } });
          return;
        }

        room.receiver = socket;
        socket.roomCode = room.code;
        socket.role = "receiver";
        sendJson(socket, { type: "room:joined", payload: { code: room.code } });
        sendJson(room.sender, { type: "room:ready", payload: { code: room.code } });
        return;
      }

      const room = rooms.get(message.payload.code);
      if (!room) {
        sendJson(socket, { type: "room:error", payload: { message: "Room not found" } });
        return;
      }

      const peer = socket === room.sender ? room.receiver : room.sender;
      if (!peer) {
        sendJson(socket, { type: "room:error", payload: { message: "Peer not connected" } });
        return;
      }

      sendJson(peer, message);
    } catch (error) {
      sendJson(socket, { type: "room:error", payload: { message: error.message || "Invalid message" } });
    }
  });

  socket.on("close", () => {
    if (!socket.roomCode) {
      return;
    }

    const room = rooms.get(socket.roomCode);
    if (!room) {
      return;
    }

    const peer = socket === room.sender ? room.receiver : room.sender;
    sendJson(peer, { type: "room:peer-left", payload: { code: room.code } });
    rooms.delete(room.code);
  });
});

setInterval(cleanupExpiredRooms, 30 * 1000);

server.listen(port, "0.0.0.0", () => {
  console.log(`signaling server listening on http://0.0.0.0:${port}`);
});
