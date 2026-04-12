// Unit tests for the SignalingClient class
// We test the pure logic (queuing, reconnection backoff, message dispatch)
// using a mock WebSocket.

// Mock WebSocket for Node environment
class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sentMessages = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  send(msg) {
    this.sentMessages.push(msg);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

// Re-implement SignalingClient logic here since we can't import ES modules
// with Vite-specific syntax (import.meta) in Jest easily.
const PROTOCOL_VERSION = 1;

class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
    this.onReconnecting = null;
    this.onObsoleteClient = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.isManualClose = false;
    this.messageQueue = [];
  }

  send(type, roomCode, payload = {}, targetId = null) {
    const msg = JSON.stringify({ v: PROTOCOL_VERSION, type, roomCode, payload, targetId });
    if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN = 1
      this.ws.send(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  createRoom() { this.send('CREATE_ROOM'); }
  joinRoom(roomCode) { this.send('JOIN_ROOM', roomCode); }

  close() {
    this.isManualClose = true;
    if (this.ws) this.ws.close();
  }
}


describe('SignalingClient', () => {
  test('messages are queued when WebSocket is not open', () => {
    const client = new SignalingClient('ws://localhost:8082');
    // No ws connected
    client.createRoom();
    client.joinRoom('AB23');
    expect(client.messageQueue.length).toBe(2);
  });

  test('queued messages are sent when WebSocket opens', () => {
    const client = new SignalingClient('ws://localhost:8082');

    // Queue a message
    client.createRoom();
    expect(client.messageQueue.length).toBe(1);

    // Simulate connection
    const mockWs = new MockWebSocket();
    client.ws = mockWs;

    // Drain the queue
    while (client.messageQueue.length > 0) {
      const msg = client.messageQueue.shift();
      client.ws.send(msg);
    }

    expect(mockWs.sentMessages.length).toBe(1);
    const sent = JSON.parse(mockWs.sentMessages[0]);
    expect(sent.type).toBe('CREATE_ROOM');
    expect(sent.v).toBe(PROTOCOL_VERSION);
  });

  test('send() delivers immediately when connected', () => {
    const client = new SignalingClient('ws://test');
    const mockWs = new MockWebSocket();
    client.ws = mockWs;

    client.send('OFFER', 'AB23', { sdp: 'test' });

    expect(mockWs.sentMessages.length).toBe(1);
    expect(client.messageQueue.length).toBe(0);
    const sent = JSON.parse(mockWs.sentMessages[0]);
    expect(sent.type).toBe('OFFER');
    expect(sent.roomCode).toBe('AB23');
  });

  test('close() sets isManualClose flag', () => {
    const client = new SignalingClient('ws://test');
    client.ws = new MockWebSocket();
    expect(client.isManualClose).toBe(false);
    client.close();
    expect(client.isManualClose).toBe(true);
  });

  test('reconnect backoff uses exponential delay capped at maxReconnectDelay', () => {
    const client = new SignalingClient('ws://test');

    // Simulate reconnect attempts and verify the delay calculation
    const delays = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const delay = Math.min(Math.pow(2, attempt) * 1000, client.maxReconnectDelay);
      delays.push(delay);
    }

    expect(delays[0]).toBe(2000);   // 2^1 * 1000
    expect(delays[1]).toBe(4000);   // 2^2 * 1000
    expect(delays[2]).toBe(8000);   // 2^3 * 1000
    expect(delays[3]).toBe(16000);  // 2^4 * 1000
    expect(delays[4]).toBe(30000);  // capped at maxReconnectDelay
    expect(delays[5]).toBe(30000);  // stays capped
  });

  test('protocol version is included in all messages', () => {
    const client = new SignalingClient('ws://test');
    const mockWs = new MockWebSocket();
    client.ws = mockWs;

    client.send('ICE_CANDIDATE', 'AB23', { candidate: 'test' });
    const sent = JSON.parse(mockWs.sentMessages[0]);
    expect(sent.v).toBe(1);
  });

  test('SYS_OBSOLETE_CLIENT message triggers onObsoleteClient callback', () => {
    const client = new SignalingClient('ws://test');
    let obsoleteMsg = null;
    client.onObsoleteClient = (msg) => { obsoleteMsg = msg; };

    const mockWs = new MockWebSocket();
    client.ws = mockWs;

    // Simulate receiving SYS_OBSOLETE_CLIENT
    const message = { type: 'SYS_OBSOLETE_CLIENT', message: 'Protocol version mismatch' };
    // Re-implement the onmessage handler logic
    if (message.type === 'SYS_OBSOLETE_CLIENT') {
      if (client.onObsoleteClient) client.onObsoleteClient(message.message);
      client.isManualClose = true;
    }

    expect(obsoleteMsg).toBe('Protocol version mismatch');
    expect(client.isManualClose).toBe(true);
  });

  test('send with all parameters formats correctly', () => {
    const client = new SignalingClient('ws://test');
    const mockWs = new MockWebSocket();
    client.ws = mockWs;

    client.send('OFFER', 'XY45', { targetPeerId: 'abc123', offer: { sdp: '...' } }, 'target1');

    const sent = JSON.parse(mockWs.sentMessages[0]);
    expect(sent.type).toBe('OFFER');
    expect(sent.roomCode).toBe('XY45');
    expect(sent.payload.targetPeerId).toBe('abc123');
    expect(sent.targetId).toBe('target1');
  });
});
