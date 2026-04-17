import { WebSocket } from 'ws';
import http from 'http';

// Dynamically import the server factory. Jest needs the --experimental-vm-modules
// flag for ESM, which is already configured in server/package.json.
let createServer;

beforeAll(async () => {
  process.env.MAX_FAILED_JOIN_ATTEMPTS = '100';
  const mod = await import('../index.js');
  createServer = mod.createServer;
});

afterAll(() => {
  delete process.env.MAX_FAILED_JOIN_ATTEMPTS;
});

describe('Server integration', () => {
  let server;
  let port;
  let baseUrl;

  beforeEach(async () => {
    server = await createServer();
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        baseUrl = `ws://localhost:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    const { gcInterval, wss } = server._boardlink;
    clearInterval(gcInterval);
    // Terminate all live clients and wait for their close events to drain
    // before closing the server. Without this drain, the server-side 'close'
    // handlers (which log) fire after Jest marks the test done, causing
    // "Cannot log after tests are done" and a non-zero exit code.
    const drainPromises = [];
    wss.clients.forEach((ws) => {
      if (ws.readyState !== 3 /* CLOSED */) {
        drainPromises.push(new Promise((r) => ws.once('close', r)));
      }
      ws.terminate();
    });
    await Promise.all(drainPromises);
    await new Promise((r) => server.close(r));
  });

  function connectWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function sendAndWait(ws, msg) {
    return new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify(msg));
    });
  }

  // --- Health endpoint ---
  test('GET /health returns 200 with status ok', (done) => {
    http.get(`http://localhost:${port}/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(body);
        expect(data.status).toBe('ok');
        expect(typeof data.rooms).toBe('number');
        expect(typeof data.uptime).toBe('number');
        done();
      });
    });
  });

  // --- Room creation ---
  test('CREATE_ROOM returns a valid 4-char room code', async () => {
    const ws = await connectWs();
    const reply = await sendAndWait(ws, { v: 1, type: 'CREATE_ROOM' });
    expect(reply.type).toBe('ROOM_CREATED');
    expect(reply.roomCode).toMatch(/^[2-9A-Z]{4}$/);
    ws.close();
  });

  // --- Join room ---
  test('student can join an existing room', async () => {
    const teacher = await connectWs();
    const createReply = await sendAndWait(teacher, { v: 1, type: 'CREATE_ROOM' });
    const roomCode = createReply.roomCode;

    const student = await connectWs();

    // Set up teacher to listen for STUDENT_JOINED
    const teacherMsg = new Promise((resolve) => {
      teacher.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    const joinReply = await sendAndWait(student, { v: 1, type: 'JOIN_ROOM', roomCode });
    expect(joinReply.type).toBe('JOIN_SUCCESS');
    expect(joinReply.roomCode).toBe(roomCode);
    expect(joinReply.peerId).toBeTruthy();
    expect(joinReply.sessionId).toBeTruthy();

    const joined = await teacherMsg;
    expect(joined.type).toBe('STUDENT_JOINED');
    expect(joined.studentCount).toBe(1);

    teacher.close();
    student.close();
  });

  // --- Join invalid room ---
  test('joining a non-existent room returns ERROR', async () => {
    const ws = await connectWs();
    const reply = await sendAndWait(ws, { v: 1, type: 'JOIN_ROOM', roomCode: 'ZZ99' });
    expect(reply.type).toBe('ERROR');
    expect(reply.message).toMatch(/invalid|expired/i);
    ws.close();
  });

  // --- Invalid room code format ---
  test('joining with bad room code format returns ERROR', async () => {
    const ws = await connectWs();
    const reply = await sendAndWait(ws, { v: 1, type: 'JOIN_ROOM', roomCode: 'ab' });
    expect(reply.type).toBe('ERROR');
    ws.close();
  });

  // --- Protocol version mismatch ---
  test('old protocol version gets SYS_OBSOLETE_CLIENT', async () => {
    const ws = await connectWs();
    const reply = await sendAndWait(ws, { v: 0, type: 'CREATE_ROOM' });
    expect(reply.type).toBe('SYS_OBSOLETE_CLIENT');
  });

  // --- Invalid JSON ---
  test('invalid JSON message is silently dropped', async () => {
    const ws = await connectWs();
    // Send garbage — should not crash, no response
    ws.send('not json at all{{{');
    // Send a valid message after to confirm server is still alive
    const reply = await sendAndWait(ws, { v: 1, type: 'CREATE_ROOM' });
    expect(reply.type).toBe('ROOM_CREATED');
    ws.close();
  });

  // --- Missing type field ---
  test('message without type is dropped (Zod validation)', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ v: 1, roomCode: 'AB23' }));
    // Confirm server is alive
    const reply = await sendAndWait(ws, { v: 1, type: 'CREATE_ROOM' });
    expect(reply.type).toBe('ROOM_CREATED');
    ws.close();
  });

  // --- Rejoin flow ---
  test('student can rejoin after disconnect using sessionId', async () => {
    const teacher = await connectWs();
    const createReply = await sendAndWait(teacher, { v: 1, type: 'CREATE_ROOM' });
    const roomCode = createReply.roomCode;

    // First student connects
    const student1 = await connectWs();
    // Eat the STUDENT_JOINED on teacher side
    const teacherJoinMsg = new Promise((resolve) => {
      teacher.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const joinReply = await sendAndWait(student1, { v: 1, type: 'JOIN_ROOM', roomCode });
    await teacherJoinMsg;

    const { sessionId, peerId } = joinReply;

    // Student disconnects
    const teacherLeftMsg = new Promise((resolve) => {
      teacher.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    student1.close();
    await teacherLeftMsg;

    // Student rejoins with sessionId
    const student2 = await connectWs();
    const teacherRejoinMsg = new Promise((resolve) => {
      teacher.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const rejoinReply = await sendAndWait(student2, {
      v: 1,
      type: 'REJOIN_ROOM',
      roomCode,
      payload: { sessionId }
    });

    expect(rejoinReply.type).toBe('REJOIN_SUCCESS');
    expect(rejoinReply.peerId).toBe(peerId); // Same peer ID preserved
    expect(rejoinReply.sessionId).toBeTruthy(); // New session ID issued

    const rejoinTeacher = await teacherRejoinMsg;
    expect(rejoinTeacher.type).toBe('STUDENT_REJOINED');

    teacher.close();
    student2.close();
  });

  // --- Rejoin with invalid sessionId ---
  test('rejoin with invalid sessionId returns ERROR', async () => {
    const ws = await connectWs();
    const reply = await sendAndWait(ws, {
      v: 1,
      type: 'REJOIN_ROOM',
      payload: { sessionId: 'nonexistent123' }
    });
    expect(reply.type).toBe('ERROR');
    expect(reply.message).toMatch(/expired/i);
    ws.close();
  });

  // --- Teacher disconnect notifies students ---
  test('teacher disconnect sends error to all students', async () => {
    const teacher = await connectWs();
    const createReply = await sendAndWait(teacher, { v: 1, type: 'CREATE_ROOM' });
    const roomCode = createReply.roomCode;

    const student = await connectWs();
    const teacherJoinMsg = new Promise((resolve) => {
      teacher.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    await sendAndWait(student, { v: 1, type: 'JOIN_ROOM', roomCode });
    await teacherJoinMsg;

    // Listen for disconnect message on student
    const studentDisconnectMsg = new Promise((resolve) => {
      student.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    teacher.close();

    const msg = await studentDisconnectMsg;
    expect(msg.type).toBe('ERROR');
    expect(msg.message).toMatch(/teacher disconnected/i);

    student.close();
  });

  // --- Rate limiting ---
  test('rate limiting kicks in after 100 failed join attempts', async () => {
    const ws = await connectWs();

    // 100 failed attempts (loose bucket — students can fat-finger freely)
    for (let i = 0; i < 100; i++) {
      const reply = await sendAndWait(ws, { v: 1, type: 'JOIN_ROOM', roomCode: 'ZZ99' });
      expect(reply.type).toBe('ERROR');
      expect(reply.message).not.toMatch(/too many/i);
    }

    // 101st should be rate limited
    const reply = await sendAndWait(ws, { v: 1, type: 'JOIN_ROOM', roomCode: 'ZZ99' });
    expect(reply.type).toBe('ERROR');
    expect(reply.message).toMatch(/too many/i);

    ws.close();
  });

  // --- Room count on health endpoint ---
  test('health endpoint reflects active room count', async () => {
    const teacher = await connectWs();
    await sendAndWait(teacher, { v: 1, type: 'CREATE_ROOM' });

    const healthRes = await new Promise((resolve) => {
      http.get(`http://localhost:${port}/health`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      });
    });

    expect(healthRes.rooms).toBe(1);
    teacher.close();
  });
});
