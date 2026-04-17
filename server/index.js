import { createServer as createHttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Config & Generators
const generateRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 4);
const generatePeerId   = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// Protocol version
const PROTOCOL_VERSION = 1;
const JOIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const parsedJoinRateLimit = Number.parseInt(process.env.MAX_FAILED_JOIN_ATTEMPTS || '0', 10);
// <= 0 disables failed-join rate limiting.
const MAX_FAILED_JOIN_ATTEMPTS = Number.isFinite(parsedJoinRateLimit) ? parsedJoinRateLimit : 0;

// Zod Schema for incoming wrapper
const MessageSchema = z.object({
  v:        z.number().int().optional(),
  type:     z.string(),
  roomCode: z.string().optional(),
  payload:  z.any().optional(),
});
const RoomCodeSchema = z.string().regex(/^[2-9A-Z]{4}$/);

/**
 * Creates and returns the HTTP + WebSocket server.
 * Call server.listen(port) to start.
 */
export async function createServer() {
  const rooms = new Map();          // roomCode -> { teacher, students, lastActivity }
  const rateLimitCache = new Map();  // ip -> { count, resetTime }
  const graceSessions = new Map();   // sessionId -> { roomCode, peerId, timer }

  // Resolve client dist path (built SPA)
  const clientDistPath = resolve(__dirname, '..', 'client', 'dist');
  const hasClientDist = existsSync(clientDistPath);

  // Load sirv for static file serving (only when dist exists)
  let serveStatic = null;
  if (hasClientDist) {
    try {
      const sirv = (await import('sirv')).default;
      serveStatic = sirv(clientDistPath, { single: true, dev: false });
    } catch {
      // sirv not installed — fall through to 404
      console.warn('[Server] sirv not installed; static file serving disabled');
    }
  }

  // HTTP server — serves static files + health check
  const httpServer = createHttpServer((req, res) => {
    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        uptime: process.uptime(),
      }));
      return;
    }

    // Serve built client SPA
    if (serveStatic) {
      serveStatic(req, res, () => {
        res.writeHead(404);
        res.end('Not Found');
      });
      return;
    }

    // No static files available
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BoardLink signaling server is running. Deploy client separately or build client/dist.');
  });

  // WebSocket server — attached to the HTTP server (same port, same origin)
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 131072, // 128KB
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
      zlibInflateOptions: { chunkSize: 10 * 1024 }
    }
  });

  // Room lifetime: 30 minutes after creation (absolute TTL)
  const ROOM_TTL_MS = 30 * 60 * 1000;

  // GC interval
  const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
      const isStale     = (now - (room.lastActivity || now)) > 60_000;
      const isExpired   = (now - (room.createdAt || now)) > ROOM_TTL_MS;
      if (isAbandoned || isStale || isExpired) {
        if (isExpired) {
          // Notify participants the room's 30-minute window has ended
          if (room.teacher && room.teacher.readyState === WebSocket.OPEN) {
            room.teacher.send(JSON.stringify({ type: 'ERROR', message: 'Room expired after 30 minutes. Please start a new session.' }));
            try { room.teacher.close(); } catch {}
          }
          for (const studentWs of room.students.values()) {
            if (studentWs.readyState === WebSocket.OPEN) {
              studentWs.send(JSON.stringify({ type: 'ERROR', message: 'This classroom expired. Ask your teacher for a new code.' }));
              try { studentWs.close(); } catch {}
            }
          }
        }
        rooms.delete(code);
        console.log(`[GC] removed room ${code}${isExpired ? ' (expired 30m)' : ''}`);
      }
    }
    // Clean up expired rate limit entries
    for (const [ip, record] of rateLimitCache) {
      if (now > record.resetTime) rateLimitCache.delete(ip);
    }
  }, 60_000);

  // Don't keep the process alive just for GC
  gcInterval.unref?.();

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port is already in use.`);
    } else {
      console.error('WSS Error:', err);
    }
  });

  wss.on('connection', (ws, req) => {
    let currentRoom = null;
    let isTeacher   = false;
    let peerId      = null;

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket.remoteAddress;

    ws.on('error', (err) => console.error('WS Error:', err));

    ws.on('message', (data) => {
      try {
        const parsed    = JSON.parse(data.toString());
        const validated = MessageSchema.parse(parsed);
        const { v, type, roomCode, payload } = validated;

        // Version gate
        if (v !== undefined && v < PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ type: 'SYS_OBSOLETE_CLIENT', message: 'Protocol version mismatch' }));
          ws.close();
          return;
        }

        console.log(`[Signaling] ${type} | room:${roomCode || '—'}`);

        switch (type) {

          case 'CREATE_ROOM': {
            const newCode = generateRoomCode();
            const createdAt = Date.now();
            rooms.set(newCode, { teacher: ws, students: new Map(), lastActivity: createdAt, createdAt });
            currentRoom = newCode;
            isTeacher   = true;
            ws.send(JSON.stringify({
              type: 'ROOM_CREATED',
              roomCode: newCode,
              expiresAt: createdAt + ROOM_TTL_MS
            }));
            console.log(`Room created: ${newCode}`);
            break;
          }

          case 'JOIN_ROOM': {
            // Optional IP rate limit. Disabled by default unless
            // MAX_FAILED_JOIN_ATTEMPTS is set to a positive integer.
            const now = Date.now();
            let record = rateLimitCache.get(ip) || { count: 0, resetTime: now + JOIN_RATE_LIMIT_WINDOW_MS };
            if (now > record.resetTime) record = { count: 0, resetTime: now + JOIN_RATE_LIMIT_WINDOW_MS };
            if (MAX_FAILED_JOIN_ATTEMPTS > 0 && record.count >= MAX_FAILED_JOIN_ATTEMPTS) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Too many failed attempts. Try again later.' }));
              return;
            }

            const codeCheck = RoomCodeSchema.safeParse(roomCode);
            if (!codeCheck.success || !rooms.has(roomCode)) {
              if (MAX_FAILED_JOIN_ATTEMPTS > 0) {
                record.count += 1;
                rateLimitCache.set(ip, record);
              }
              ws.send(JSON.stringify({ type: 'ERROR', message: 'This code is invalid or has expired.' }));
              return;
            }

            const room = rooms.get(roomCode);

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

            const sessionId = generatePeerId();
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
            rejoinRoom.students.set(peerId, ws);
            rejoinRoom.lastActivity = Date.now();
            currentRoom      = grace.roomCode;
            isTeacher        = false;

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

          case 'ANSWER': {
            if (isTeacher || !currentRoom || !rooms.has(currentRoom)) break;
            const room = rooms.get(currentRoom);
            room.lastActivity = Date.now();
            if (room.teacher.readyState === WebSocket.OPEN) {
              room.teacher.send(JSON.stringify({ type: 'ANSWER', payload, peerId }));
            }
            break;
          }

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
        room.students.forEach((studentWs) => {
          if (studentWs.readyState === WebSocket.OPEN) {
            studentWs.send(JSON.stringify({ type: 'ERROR', message: 'Your session has ended - the teacher disconnected.' }));
          }
        });
        for (const [sid, g] of graceSessions) {
          if (g.roomCode === currentRoom) {
            if (g.timer) clearTimeout(g.timer);
            graceSessions.delete(sid);
          }
        }
        rooms.delete(currentRoom);
        console.log(`Room deleted (teacher left): ${currentRoom}`);

      } else {
        if (!peerId) {
          for (const [id, studentWs] of room.students.entries()) {
            if (studentWs === ws) { peerId = id; break; }
          }
        }
        if (!peerId) return;

        room.students.delete(peerId);
        room.lastActivity = Date.now();

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

  // Expose internals for testing
  httpServer._boardlink = { rooms, rateLimitCache, graceSessions, wss, gcInterval };

  return httpServer;
}

// Start the server if not imported as a module for testing
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const PORT = process.env.PORT || 8082;
  createServer().then((server) => {
    server.listen(PORT, () => {
      console.log(`BoardLink server running on http://0.0.0.0:${PORT}`);
    });
  });
}
