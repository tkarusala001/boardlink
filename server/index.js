import { WebSocketServer, WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';

// Alphanumeric, uppercase, excluding confused characters (0, O, I, 1) as per REQ-001
const generateRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 4);
const generatePeerId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

const PORT = 8082;
const wss = new WebSocketServer({ 
  port: PORT,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    }
  }
});

// Map of roomCode -> { teacher: ws, students: Map<peerId, ws> }
const rooms = new Map();

console.log(`Signaling server running on ws://localhost:${PORT}`);

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please check for running processes.`);
  } else {
    console.error('WSS Error:', err);
  }
});

wss.on('connection', (ws) => {
  let currentRoom = null;
  let isTeacher = false;
  let peerId = null;

  ws.on('error', (err) => console.error('WS Error:', err));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, roomCode, payload } = message;
      console.log(`Received: ${type} for room: ${roomCode}`);

      switch (type) {
      case 'CREATE_ROOM':
        const newCode = generateRoomCode();
        rooms.set(newCode, { teacher: ws, students: new Map() });
        currentRoom = newCode;
        isTeacher = true;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomCode: newCode }));
        console.log(`Room created: ${newCode}`);
        break;

      case 'JOIN_ROOM':
        if (rooms.has(roomCode)) {
          const room = rooms.get(roomCode);
          peerId = generatePeerId();
          room.students.set(peerId, ws);
          currentRoom = roomCode;
          isTeacher = false;
          ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', roomCode, peerId }));
          
          room.teacher.send(JSON.stringify({
            type: 'STUDENT_JOINED',
            studentCount: room.students.size,
            peerId
          }));
          console.log(`Student joined room: ${roomCode}`);
        } else {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'This code has expired — ask your teacher for a new one' }));
        }
        break;

      case 'OFFER':
        if (!isTeacher) break;
        if (!currentRoom || !rooms.has(currentRoom)) break;
        const offerRoom = rooms.get(currentRoom);
        if (!payload?.targetPeerId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing target peer id for OFFER' }));
          break;
        }
        const offerTarget = offerRoom.students.get(payload.targetPeerId);
        if (offerTarget && offerTarget.readyState === WebSocket.OPEN) {
          offerTarget.send(JSON.stringify({
            type: 'OFFER',
            payload: payload.offer,
            peerId: payload.targetPeerId
          }));
        }
        break;

      case 'ANSWER':
        if (isTeacher) break;
        if (currentRoom && rooms.has(currentRoom)) {
          const answerRoom = rooms.get(currentRoom);
          if (answerRoom.teacher.readyState === WebSocket.OPEN) {
            answerRoom.teacher.send(JSON.stringify({
              type: 'ANSWER',
              payload,
              peerId
            }));
          }
        }
        break;

      case 'ICE_CANDIDATE':
        if (!currentRoom || !rooms.has(currentRoom)) break;
        const iceRoom = rooms.get(currentRoom);
        if (isTeacher) {
          if (!payload?.targetPeerId) break;
          const iceTarget = iceRoom.students.get(payload.targetPeerId);
          if (iceTarget && iceTarget.readyState === WebSocket.OPEN) {
            iceTarget.send(JSON.stringify({
              type: 'ICE_CANDIDATE',
              payload: payload.candidate,
              peerId: payload.targetPeerId
            }));
          }
        } else if (iceRoom.teacher.readyState === WebSocket.OPEN) {
          iceRoom.teacher.send(JSON.stringify({
            type: 'ICE_CANDIDATE',
            payload,
            peerId
          }));
        }
        break;

      default:
        console.log(`Unknown message type: ${type}`);
    }
    } catch (err) {
      console.error('Failed to process message:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      if (isTeacher) {
        // If teacher leaves, invalidate room and notify students
        room.students.forEach(studentWs => {
          studentWs.send(JSON.stringify({ type: 'ERROR', message: 'Your session has ended — the teacher disconnected.' }));
        });
        rooms.delete(currentRoom);
        console.log(`Room deleted (teacher left): ${currentRoom}`);
      } else {
        // If student leaves, just remove from set
        if (peerId) {
          room.students.delete(peerId);
        } else {
          for (const [id, studentWs] of room.students.entries()) {
            if (studentWs === ws) {
              room.students.delete(id);
              peerId = id;
              break;
            }
          }
        }
        if (room.teacher.readyState === ws.OPEN) {
          room.teacher.send(JSON.stringify({
            type: 'STUDENT_LEFT',
            studentCount: room.students.size,
            peerId
          }));
        }
        console.log(`Student left room: ${currentRoom}`);
      }
    }
  });
});
