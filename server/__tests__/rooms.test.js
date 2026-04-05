import { WebSocket } from 'ws';

// Test room data structure and GC logic in isolation
describe('Room management', () => {
  let rooms;

  beforeEach(() => {
    rooms = new Map();
  });

  function makeRoom(teacherOpen = true, studentCount = 0, lastActivity = Date.now()) {
    const teacher = { readyState: teacherOpen ? WebSocket.OPEN : WebSocket.CLOSED };
    const students = new Map();
    for (let i = 0; i < studentCount; i++) {
      students.set(`peer-${i}`, { readyState: WebSocket.OPEN });
    }
    return { teacher, students, lastActivity };
  }

  test('room with open teacher and students is not abandoned', () => {
    const room = makeRoom(true, 2);
    const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
    expect(isAbandoned).toBe(false);
  });

  test('room with closed teacher and no students is abandoned', () => {
    const room = makeRoom(false, 0);
    const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
    expect(isAbandoned).toBe(true);
  });

  test('room with null teacher and no students is abandoned', () => {
    const room = { teacher: null, students: new Map(), lastActivity: Date.now() };
    const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
    expect(isAbandoned).toBe(true);
  });

  test('room with closed teacher but active students is NOT abandoned', () => {
    const room = makeRoom(false, 1);
    const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
    expect(isAbandoned).toBe(false);
  });

  test('stale room detection works after 60s', () => {
    const room = makeRoom(true, 1, Date.now() - 61_000);
    const isStale = (Date.now() - (room.lastActivity || Date.now())) > 60_000;
    expect(isStale).toBe(true);
  });

  test('active room is not stale', () => {
    const room = makeRoom(true, 1, Date.now());
    const isStale = (Date.now() - (room.lastActivity || Date.now())) > 60_000;
    expect(isStale).toBe(false);
  });

  test('GC sweep removes abandoned rooms from map', () => {
    rooms.set('AAAA', makeRoom(true, 1));
    rooms.set('BBBB', makeRoom(false, 0));
    rooms.set('CCCC', makeRoom(true, 0, Date.now() - 120_000));

    // Simulate GC sweep
    for (const [code, room] of rooms) {
      const isAbandoned = (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) && room.students.size === 0;
      const isStale = (Date.now() - (room.lastActivity || Date.now())) > 60_000;
      if (isAbandoned || isStale) rooms.delete(code);
    }

    expect(rooms.has('AAAA')).toBe(true);
    expect(rooms.has('BBBB')).toBe(false);
    expect(rooms.has('CCCC')).toBe(false);
  });
});
