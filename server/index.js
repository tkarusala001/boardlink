import { WebSocketServer } from 'ws';
import { customAlphabet } from 'nanoid';

// Alphanumeric, uppercase, excluding confused characters (0, O, I, 1) as per REQ-001
const generateRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 4);

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

// Map of roomCode -> { teacher: ws, students: Set<ws> }
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

  ws.on('error', (err) => console.error('WS Error:', err));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, roomCode, payload } = message;
      console.log(`Received: ${type} for room: ${roomCode}`);

    switch (type) {
      case 'CREATE_ROOM':
        const newCode = generateRoomCode();
        rooms.set(newCode, { teacher: ws, students: new Set() });
        currentRoom = newCode;
        isTeacher = true;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomCode: newCode }));
        console.log(`Room created: ${newCode}`);
        break;

      case 'JOIN_ROOM':
        if (rooms.has(roomCode)) {
          const room = rooms.get(roomCode);
          room.students.add(ws);
          currentRoom = roomCode;
          isTeacher = false;
          ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', roomCode }));
          
          // Notify teacher that a student joined (optional for now)
          room.teacher.send(JSON.stringify({ type: 'STUDENT_JOINED', studentCount: room.students.size }));
          console.log(`Student joined room: ${roomCode}`);
        } else {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'This code has expired — ask your teacher for a new one' }));
        }
        break;

      case 'OFFER':
      case 'ANSWER':
      case 'ICE_CANDIDATE':
        // Relay messages between peers
        if (currentRoom && rooms.has(currentRoom)) {
          const room = rooms.get(currentRoom);
          if (isTeacher) {
            // Teacher sends offer/candidate to all students or specific one
            // For V1.0, we relay to all students in the room
            room.students.forEach(studentWs => {
              if (studentWs.readyState === ws.OPEN) {
                studentWs.send(JSON.stringify({ type, payload }));
              }
            });
          } else {
            // Student sends answer/candidate back to teacher
            if (room.teacher.readyState === ws.OPEN) {
              room.teacher.send(JSON.stringify({ type, payload }));
            }
          }
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
        room.students.delete(ws);
        if (room.teacher.readyState === ws.OPEN) {
          room.teacher.send(JSON.stringify({ type: 'STUDENT_LEFT', studentCount: room.students.size }));
        }
        console.log(`Student left room: ${currentRoom}`);
      }
    }
  });
});
