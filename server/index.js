import { WebSocketServer, WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';

// Config & Generators
const generateRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 4);
const generatePeerId   = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

const PORT = 8082;
const wss = new WebSocketServer({
  port: PORT,
  maxPayload: 4096, // Hard limit 4KB to prevent spam
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 }
  }
});

// Protocol version
const PROTOCOL_VERSION = 1;

// Zod Schema for incoming wrapper
const MessageSchema = z.object({
  v:        z.number().int().optional(),
  type:     z.string(),
  roomCode: z.string().optional(),
  payload:  z.any().optional(),
});
const RoomCodeSchema = z.string().regex(/^[2-9A-Z]{4}$/);

// ── Maps ──────────────────────────────────────────────────────────────────────
// roomCode -> { teacher: ws, students: Map<peerId, ws>, lastActivity: number }
const rooms = new Map();
// ip -> { count, resetTime }
const rateLimitCache = new Map();
// sessionId -> { roomCode, peerId, timer } — 30 s grace for reconnecting students
const graceSessions = new Map();

// ── Room Garbage Collector ────────────────────────────────────────────────────
// Sweeps abandoned / stale rooms every 60 s to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const isAbandoned = room.teacher.readyState !== WebSocket.OPEN && room.students.size === 0;
    const isStale     = (now - (room.lastActivity || now)) > 60_000;
    if (isAbandoned || isStale) {
      rooms.delete(code);
      console.log(`[GC] Collected ghost room: ${code} (abandoned=${isAbandoned}, stale=${isStale})`);
    }
  }
}, 60_000);

console.log(`Signaling server running on ws://localhost:${PORT}`);

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error('WSS Error:', err);
  }
});

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let isTeacher   = false;
  let peerId      = null;       // set after JOIN_ROOM / REJOIN_ROOM

  const ip = req.socket.remoteAddress;

  ws.on('error', (err) => console.error('WS Error:', err));

  ws.on('message', (data) => {
    try {
      const parsed    = JSON.parse(data.toString());
      const validated = MessageSchema.parse(parsed);
      const { v, type, roomCode, payload } = validated;

      // Version gate — kick stale clients
      if (v !== undefined && v < PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ type: 'SYS_OBSOLETE_CLIENT', message: 'Your client is outdated. Please refresh the page.' }));
        ws.close();
        return;
      }

      console.log(`[Signaling] ${type} | room:${roomCode || '—'}`);

      switch (type) {

        // ── Teacher creates a room ────────────────────────────────────────────
        case 'CREATE_ROOM': {
          const newCode = generateRoomCode();
          rooms.set(newCode, { teacher: ws, students: new Map(), lastActivity: Date.now() });
          currentRoom = newCode;
          isTeacher   = true;
          ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomCode: newCode }));
          console.log(`Room created: ${newCode}`);
          break;
        }

        // ── Student joins for the first time ─────────────────────────────────
        case 'JOIN_ROOM': {
          // IP rate limit
          const now = Date.now();
          let record = rateLimitCache.get(ip) || { count: 0, resetTime: now + 15 * 60 * 1000 };
          if (now > record.resetTime) record = { count: 0, resetTime: now + 15 * 60 * 1000 };
          if (record.count >= 5) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Too many failed attempts. Try again later.' }));
            return;
          }

          const codeCheck = RoomCodeSchema.safeParse(roomCode);
          if (!codeCheck.success || !rooms.has(roomCode)) {
            record.count += 1;
            rateLimitCache.set(ip, record);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'This code is invalid or has expired.' }));
            return;
          }

          const room = rooms.get(roomCode);

          // Collision-safe peerId generation
          let attempts = 0;
          do { peerId = generatePeerId(); attempts++; }
          while (room.students.has(peerId) && attempts < 10);
          if (room.students.has(peerId)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Unable to allocate peer session. Please try again.' }));
            break;
          }

          room.students.set(peerId, ws);
          room.lastActivity = Date.now();
          currentRoom       = roomCode;
          isTeacher         = false;

          // The sessionId we send back is used by the client for REJOIN_ROOM.
          // We create a grace entry immediately so reconnect works even on the first drop.
          const sessionId   = generatePeerId();
          // Start a long-lived grace entry (refreshed on every clean disconnect)
          graceSessions.set(sessionId, { roomCode, peerId, timer: null });

          ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', roomCode, peerId, sessionId }));

          if (room.teacher.readyState === WebSocket.OPEN) {
            room.teacher.send(JSON.stringify({
              type: 'STUDENT_JOINED',
              studentCount: room.students.size,
              peerId
            }));
          }
          console.log(`Student ${peerId} joined room: ${roomCode}`);
          break;
        }

        // ── Student reconnects within 30 s grace period ───────────────────────
        case 'REJOIN_ROOM': {
          const sessionId = payload?.sessionId;
          if (!sessionId || !graceSessions.has(sessionId)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Session expired. Please re-enter the room code.' }));
            break;
          }

          const grace = graceSessions.get(sessionId);
          if (grace.timer) clearTimeout(grace.timer);
          graceSessions.delete(sessionId);

          if (!rooms.has(grace.roomCode)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'The room has closed. Ask your teacher for a new code.' }));
            break;
          }

          const rejoinRoom = rooms.get(grace.roomCode);
          peerId           = grace.peerId;
          rejoinRoom.students.set(peerId, ws); // re-register new ws
          rejoinRoom.lastActivity = Date.now();
          currentRoom      = grace.roomCode;
          isTeacher        = false;

          // Issue a fresh sessionId for the next possible disconnect
          const newSessionId = generatePeerId();
          graceSessions.set(newSessionId, { roomCode: grace.roomCode, peerId, timer: null });

          ws.send(JSON.stringify({ type: 'REJOIN_SUCCESS', roomCode: grace.roomCode, peerId, sessionId: newSessionId }));

          if (rejoinRoom.teacher.readyState === WebSocket.OPEN) {
            rejoinRoom.teacher.send(JSON.stringify({
              type: 'STUDENT_REJOINED',
              peerId,
              studentCount: rejoinRoom.students.size
            }));
          }
          console.log(`Student ${peerId} rejoined room: ${grace.roomCode}`);
          break;
        }

        // ── WebRTC signaling: Teacher -> Student ──────────────────────────────
        case 'OFFER': {
          if (!isTeacher || !currentRoom || !rooms.has(currentRoom)) break;
          const room = rooms.get(currentRoom);
          room.lastActivity = Date.now();

          if (!payload?.targetPeerId) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing targetPeerId for OFFER' }));
            break;
          }
          const target = room.students.get(payload.targetPeerId);
          if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ type: 'OFFER', payload: payload.offer, peerId: payload.targetPeerId }));
          }
          break;
        }

        // ── WebRTC signaling: Student -> Teacher ──────────────────────────────
        case 'ANSWER': {
          if (isTeacher || !currentRoom || !rooms.has(currentRoom)) break;
          const room = rooms.get(currentRoom);
          room.lastActivity = Date.now();
          if (room.teacher.readyState === WebSocket.OPEN) {
            room.teacher.send(JSON.stringify({ type: 'ANSWER', payload, peerId }));
          }
          break;
        }

        // ── ICE candidates (bidirectional) ────────────────────────────────────
        case 'ICE_CANDIDATE': {
          if (!currentRoom || !rooms.has(currentRoom)) break;
          const room = rooms.get(currentRoom);
          room.lastActivity = Date.now();

          if (isTeacher) {
            if (!payload?.targetPeerId) break;
            const target = room.students.get(payload.targetPeerId);
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({ type: 'ICE_CANDIDATE', payload: payload.candidate, peerId: payload.targetPeerId }));
            }
          } else {
            if (room.teacher.readyState === WebSocket.OPEN) {
              room.teacher.send(JSON.stringify({ type: 'ICE_CANDIDATE', payload, peerId }));
            }
          }
          break;
        }

        default:
          console.log(`[Signaling] Unknown type: ${type}`);
      }

    } catch (err) {
      if (err instanceof z.ZodError) {
        console.warn('[Signaling] Invalid payload dropped');
      } else {
        console.error('[Signaling] Error:', err);
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);

    if (isTeacher) {
      // Teacher left — notify all students and delete room
      room.students.forEach((studentWs) => {
        if (studentWs.readyState === WebSocket.OPEN) {
          studentWs.send(JSON.stringify({ type: 'ERROR', message: 'Your session has ended — the teacher disconnected.' }));
        }
      });
      // Also expire all grace sessions for this room
      for (const [sid, g] of graceSessions) {
        if (g.roomCode === currentRoom) {
          if (g.timer) clearTimeout(g.timer);
          graceSessions.delete(sid);
        }
      }
      rooms.delete(currentRoom);
      console.log(`Room deleted (teacher left): ${currentRoom}`);

    } else {
      // Student disconnected — find their peerId if not already set
      if (!peerId) {
        for (const [id, studentWs] of room.students.entries()) {
          if (studentWs === ws) { peerId = id; break; }
        }
      }
      if (!peerId) return;

      room.students.delete(peerId);
      room.lastActivity = Date.now();

      // Start 30 s grace-period timer for any existing grace entry for this peer
      for (const [sid, g] of graceSessions) {
        if (g.roomCode === currentRoom && g.peerId === peerId) {
          if (g.timer) clearTimeout(g.timer);
          g.timer = setTimeout(() => {
            graceSessions.delete(sid);
            console.log(`[Grace] Session expired for peer ${peerId}`);
          }, 30_000);
          break;
        }
      }

      if (room.teacher.readyState === WebSocket.OPEN) {
        room.teacher.send(JSON.stringify({
          type: 'STUDENT_LEFT',
          studentCount: room.students.size,
          peerId
        }));
      }
      console.log(`Student ${peerId} left room: ${currentRoom} (30 s grace started)`);
    }
  });
});
