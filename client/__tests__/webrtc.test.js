// Unit tests for WebRTCClient logic
// We test the pure state management / method behavior without actual browser APIs.
// RTCPeerConnection is mocked.

class MockRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.ondatachannel = null;
    this._tracks = [];
    this._candidates = [];
    this._dataChannels = [];
  }

  addTrack(track, stream) {
    this._tracks.push({ track, stream });
  }

  async createOffer() {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate) {
    this._candidates.push(candidate);
  }

  createDataChannel(label, opts) {
    const channel = {
      label,
      opts,
      readyState: 'open',
      onmessage: null,
      send: jest.fn(),
      close: jest.fn(),
    };
    this._dataChannels.push(channel);
    return channel;
  }

  restartIce() {}

  close() {
    this.connectionState = 'closed';
  }
}

// Re-implement the core WebRTCClient logic for testing
class WebRTCClient {
  constructor(signaling, isTeacher = false, iceConfig = null) {
    this.signaling = signaling;
    this.isTeacher = isTeacher;
    this.roomCode = null;
    this.peers = new Map();
    this.stream = null;
    this.pc = null;
    this.onStream = null;
    this.dataChannel = null;
    this.onData = null;
    this.localPeerId = null;

    this.config = iceConfig || {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    };
  }

  setLocalPeerId(id) {
    this.localPeerId = id;
  }

  async createStudentConnection(studentId) {
    if (!this.isTeacher || !this.stream) return;

    const pc = new MockRTCPeerConnection(this.config);
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));

    const dataChannel = pc.createDataChannel('cursorUpdates', { ordered: false, maxRetransmits: 0 });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.roomCode, event.candidate, studentId);
      }
    };

    this.peers.set(studentId, { pc, dataChannel });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.roomCode, studentId, offer);
  }

  async handleOffer(offer) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send('ANSWER', this.roomCode, answer);
  }

  async handleAnswer(answer, studentId) {
    if (!this.isTeacher || !this.peers.has(studentId)) return;
    await this.peers.get(studentId).pc.setRemoteDescription(answer);
  }

  async handleIceCandidate(candidate, studentId) {
    if (!candidate) return;
    if (this.isTeacher && studentId && this.peers.has(studentId)) {
      await this.peers.get(studentId).pc.addIceCandidate(candidate);
    } else if (!this.isTeacher && this.pc) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  onStudentLeft(studentId) {
    const peer = this.peers.get(studentId);
    if (!peer) return;
    if (peer.dataChannel) peer.dataChannel.close();
    peer.pc.close();
    this.peers.delete(studentId);
  }

  sendCursor(x, y) {
    const msg = JSON.stringify({ type: 'CURSOR', x, y });
    if (this.isTeacher) {
      for (const [id, peer] of this.peers) {
        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
          peer.dataChannel.send(msg);
        }
      }
    } else if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(msg);
    }
  }

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.isTeacher) {
      for (const [id, peer] of this.peers) {
        if (peer.pc) peer.pc.close();
      }
      this.peers.clear();
    } else if (this.pc) {
      this.pc.close();
    }
  }
}

// Mock signaling client
function createMockSignaling() {
  return {
    send: jest.fn(),
    sendOffer: jest.fn(),
    sendAnswer: jest.fn(),
    sendIceCandidate: jest.fn(),
  };
}

// Mock MediaStream
function createMockStream() {
  const track = {
    kind: 'video',
    stop: jest.fn(),
    getSettings: () => ({ width: 1920, height: 1080 }),
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
}


describe('WebRTCClient', () => {

  test('uses default ICE config when none provided', () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    expect(client.config.iceServers).toHaveLength(2);
    expect(client.config.iceServers[0].urls).toBe('stun:stun.l.google.com:19302');
  });

  test('accepts custom ICE config', () => {
    const signaling = createMockSignaling();
    const customConfig = {
      iceServers: [
        { urls: 'turn:my-turn.example.com:3478', username: 'user', credential: 'pass' },
      ]
    };
    const client = new WebRTCClient(signaling, false, customConfig);
    expect(client.config.iceServers).toHaveLength(1);
    expect(client.config.iceServers[0].urls).toContain('turn:');
  });

  test('setLocalPeerId stores the value', () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    client.setLocalPeerId('abc123');
    expect(client.localPeerId).toBe('abc123');
  });

  test('teacher createStudentConnection creates a peer and sends offer', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('student1');

    expect(client.peers.has('student1')).toBe(true);
    const peer = client.peers.get('student1');
    expect(peer.pc.localDescription).toEqual({ type: 'offer', sdp: 'mock-offer-sdp' });
    expect(signaling.sendOffer).toHaveBeenCalledWith('AB23', 'student1', expect.objectContaining({ type: 'offer' }));
  });

  test('createStudentConnection does nothing if not teacher', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    await client.createStudentConnection('student1');
    expect(client.peers.size).toBe(0);
  });

  test('createStudentConnection does nothing without stream', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    // No stream set
    await client.createStudentConnection('student1');
    expect(client.peers.size).toBe(0);
  });

  test('handleAnswer sets remote description on the correct peer', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('student1');

    const answer = { type: 'answer', sdp: 'answer-sdp' };
    await client.handleAnswer(answer, 'student1');

    expect(client.peers.get('student1').pc.remoteDescription).toEqual(answer);
  });

  test('handleAnswer ignores unknown student', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    // Should not throw
    await client.handleAnswer({ type: 'answer', sdp: 'test' }, 'unknown');
    expect(client.peers.size).toBe(0);
  });

  test('handleIceCandidate adds candidate to correct peer (teacher)', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('student1');

    const candidate = { candidate: 'test-candidate', sdpMid: '0' };
    await client.handleIceCandidate(candidate, 'student1');

    expect(client.peers.get('student1').pc._candidates).toContain(candidate);
  });

  test('handleIceCandidate adds candidate to pc (student)', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    client.pc = new MockRTCPeerConnection(client.config);

    const candidate = { candidate: 'test-candidate' };
    await client.handleIceCandidate(candidate);

    expect(client.pc._candidates).toContain(candidate);
  });

  test('handleIceCandidate ignores null candidate', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    client.pc = new MockRTCPeerConnection(client.config);

    await client.handleIceCandidate(null);
    expect(client.pc._candidates).toHaveLength(0);
  });

  test('onStudentLeft closes and removes the peer', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('student1');
    expect(client.peers.has('student1')).toBe(true);

    client.onStudentLeft('student1');
    expect(client.peers.has('student1')).toBe(false);
  });

  test('onStudentLeft does nothing for unknown peer', () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    // Should not throw
    client.onStudentLeft('nonexistent');
    expect(client.peers.size).toBe(0);
  });

  test('sendCursor sends to all peers (teacher)', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('s1');
    await client.createStudentConnection('s2');

    client.sendCursor(0.5, 0.3);

    for (const [id, peer] of client.peers) {
      expect(peer.dataChannel.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'CURSOR', x: 0.5, y: 0.3 })
      );
    }
  });

  test('close() stops stream tracks and closes all peers (teacher)', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, true);
    client.stream = createMockStream();
    client.roomCode = 'AB23';

    await client.createStudentConnection('s1');

    client.close();

    expect(client.stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(client.peers.size).toBe(0);
  });

  test('close() closes pc (student)', () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    client.pc = new MockRTCPeerConnection(client.config);

    client.close();
    expect(client.pc.connectionState).toBe('closed');
  });

  test('handleOffer creates answer and sets descriptions (student)', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    client.pc = new MockRTCPeerConnection(client.config);
    client.roomCode = 'AB23';

    const offer = { type: 'offer', sdp: 'incoming-offer' };
    await client.handleOffer(offer);

    expect(client.pc.remoteDescription).toEqual(offer);
    expect(client.pc.localDescription).toEqual({ type: 'answer', sdp: 'mock-answer-sdp' });
    expect(signaling.send).toHaveBeenCalledWith('ANSWER', 'AB23', expect.objectContaining({ type: 'answer' }));
  });

  test('handleOffer does nothing without pc', async () => {
    const signaling = createMockSignaling();
    const client = new WebRTCClient(signaling, false);
    // pc is null
    await client.handleOffer({ type: 'offer', sdp: 'test' });
    expect(signaling.send).not.toHaveBeenCalled();
  });
});
