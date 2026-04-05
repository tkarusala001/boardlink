import { WebSocketServer } from 'ws';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';

// Config & Generators
const generateRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 4);
const generateStudentId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

const PORT = 8082;
const wss = new WebSocketServer({
  port: PORT,
  maxPayload: 4096, // Hard limit 4KB to prevent spam (prevents abuse REQ)
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 }
  }
});

// Protocol version
const PROTOCOL_VERSION = 1;

// Zod Schema for incoming wrapper
const MessageSchema = z.object({
  v: z.number().int().optional(), // Protocol version (optional for backwards compat check)
  type: z.string(),
  roomCode: z.string().optional(),
  payload: z.any().optional(),
  targetId: z.string().optional()
});
const RoomCodeSchema = z.string().regex(/^[2-9A-Z]{4}$/);

// Maps
const rooms = new Map(); // roomCode -> { teacher: ws, students: Map<studentId, ws>, lastActivity: number }
const rateLimitCache = new Map(); // ip -> { count, resetTime }

// --- Room Garbage Collector ---
// Removes ghost rooms (teacher disconnected, no students) that are stale > 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const isAbandoned = room.teacher.readyState !== 1 /* OPEN */ && room.students.size === 0;
    const isStale = (now - (room.lastActivity || now)) > 60_000;
    if (isAbandoned || isStale) {
      rooms.delete(code);
      console.log(`[GC] Collected ghost room: ${code} (abandoned=${isAbandoned}, stale=${isStale})`);
    }
  }
}, 60_000);

console.log(`Signaling server running on ws://localhost:${PORT}`);

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please check for running processes.`);
  } else {
    console.error('WSS Error:', err);
  }
});

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let isTeacher = false;
  let myStudentId = null;

  // Rate limiting basics
  const ip = req.socket.remoteAddress;

  ws.on('error', (err) => console.error('WS Error:', err));

  ws.on('message', (data) => {
    try {
      // 1. Check Rate Limit early for JOIN_ROOM
      const msgStr = data.toString();
      const parsed = JSON.parse(msgStr);

      // 2. Validate Schema
      const validated = MessageSchema.parse(parsed);
      const { v, type, roomCode, payload, targetId } = validated;

      // 3. Version check — reject clients below current protocol version
      if (v !== undefined && v < PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ type: 'SYS_OBSOLETE_CLIENT', message: 'Your client is outdated. Please refresh the page.' }));
        ws.close();
        return;
      }

      console.log(`Received: ${type} for room: ${roomCode}`);

      switch (type) {
        case 'CREATE_ROOM': {
          const newCode = generateRoomCode();
          rooms.set(newCode, { teacher: ws, students: new Map(), lastActivity: Date.now() });
          currentRoom = newCode;
          isTeacher = true;
          ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomCode: newCode }));
          console.log(`Room created: ${newCode}`);
          break;
        }

        case 'JOIN_ROOM': {
          // IP Rate Limiting Check
          const now = Date.now();
          let record = rateLimitCache.get(ip) || { count: 0, resetTime: now + 15 * 60 * 1000 };
          if (now > record.resetTime) record = { count: 0, resetTime: now + 15 * 60 * 1000 };

          if (record.count >= 5) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Too many failed attempts. Try again later.' }));
            return;
          }

          // Strict validation on code
          const codeCheck = RoomCodeSchema.safeParse(roomCode);
          if (!codeCheck.success || !rooms.has(roomCode)) {
            record.count += 1;
            rateLimitCache.set(ip, record);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'This code is invalid or has expired.' }));
            return;
          }

          // Successful Join
          const room = rooms.get(roomCode);
          myStudentId = generateStudentId();
          room.students.set(myStudentId, ws);
          room.lastActivity = Date.now(); // Update activity on join
          currentRoom = roomCode;
          isTeacher = false;

          ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', roomCode }));

          // Notify teacher with the precise studentId to trigger 1:N WebRTC offer
          if (room.teacher.readyState === ws.OPEN) {
            room.teacher.send(JSON.stringify({ type: 'STUDENT_JOINED', studentId: myStudentId, studentCount: room.students.size }));
          }
          console.log(`Student ${myStudentId} joined room: ${roomCode}`);
          break;
        }

        case 'OFFER':
        case 'ANSWER':
        case 'ICE_CANDIDATE': {
          // Point-to-point signaling based on targetId (1:N design)
          if (!currentRoom || !rooms.has(currentRoom)) break;
          const room = rooms.get(currentRoom);
          room.lastActivity = Date.now(); // Signaling activity keeps room alive

          if (isTeacher) {
            // Teacher routing outward to a specific student
            if (targetId && room.students.has(targetId)) {
              const targetWs = room.students.get(targetId);
              if (targetWs.readyState === ws.OPEN) {
                targetWs.send(JSON.stringify({ type, payload }));
              }
            }
          } else {
            // Student routing inward to teacher
            if (room.teacher.readyState === ws.OPEN) {
              room.teacher.send(JSON.stringify({ type, payload, studentId: myStudentId }));
            }
          }
          break;
        }

        default:
          console.log(`Unknown message type: ${type}`);
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        console.warn('Invalid payload format dropped');
      } else {
        console.error('Failed to process message:', err);
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      if (isTeacher) {
        // Teacher left
        room.students.forEach((studentWs) => {
          if (studentWs.readyState === ws.OPEN) {
            studentWs.send(JSON.stringify({ type: 'ERROR', message: 'Your session has ended — the teacher disconnected.' }));
          }
        });
        rooms.delete(currentRoom);
        console.log(`Room deleted (teacher left): ${currentRoom}`);
      } else {
        // Student left
        if (myStudentId) {
          room.students.delete(myStudentId);
          if (room.teacher.readyState === ws.OPEN) {
            room.teacher.send(JSON.stringify({ type: 'STUDENT_LEFT', studentId: myStudentId, studentCount: room.students.size }));
          }
          console.log(`Student ${myStudentId} left room: ${currentRoom}`);
        }
      }
    }
  });
});
