export default class WebRTCClient {
  constructor(signaling, isTeacher = false, iceConfig = null) {
    this.signaling = signaling;
    this.isTeacher = isTeacher;
    this.roomCode = null;
    
    // Teacher state
    this.peers = new Map(); // studentId -> { pc, dataChannel, candidateQueue }
    this.stream = null;
    this.pendingStudents = [];
    
    // Student state
    this.pc = null;
    this.candidateQueue = [];
    this.earlyStream = null;
    this.onStream = null;
    this.dataChannel = null;
    this.onData = null;
    this.localPeerId = null;

    // ICE configuration — accept custom config or use defaults
    this.config = iceConfig || {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
  }

  setupPCListeners(pc, id = 'Student') {
    pc.onicegatheringstatechange = () => {
      console.log(`[ICE] ${id} Gathering State: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] ${id} Connection State: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${id} Overall State: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        console.log(`%c[WebRTC] ${id} CONNECTION ESTABLISHED`, 'color: #00ff00; font-weight: bold;');
      }
      if (pc.connectionState === 'failed') {
        console.error(`[WebRTC] ${id} Connection FAILED. Check if ports are blocked.`);
        if (this.isTeacher) pc.restartIce();
      }
    };
  }

  async start(roomCode) {
    this.roomCode = roomCode;

    if (this.isTeacher) {
      console.log('[WebRTC] Initiating Teacher setup...');
      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 10, max: 15 }
          },
          audio: false
        });
        console.log('[WebRTC] Screen capture active. Processing pending students:', this.pendingStudents.length);
        
        while (this.pendingStudents.length > 0) {
          const sid = this.pendingStudents.shift();
          this.createStudentConnection(sid);
        }
      } catch (err) {
        console.error('[WebRTC] getDisplayMedia failed:', err);
        throw err;
      }
    } else {
      console.log('[WebRTC] Initializing Student PeerConnection...');
      this.pc = new RTCPeerConnection(this.config);
      this.setupPCListeners(this.pc, 'Student');

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`[ICE] Student Candidate generated: ${event.candidate.candidate.substring(0, 60)}...`);
          this.signaling.send('ICE_CANDIDATE', this.roomCode, event.candidate, null);
        } else {
          console.log('[ICE] Student Gathering complete (null candidate)');
        }
      };

      this.pc.ontrack = (event) => {
        console.log('[WebRTC] Remote track received!');
        const stream = event.streams[0];
        if (this.pc.remoteDescription) {
          if (this.onStream) this.onStream(stream);
        } else {
          console.log('[WebRTC] Early track detected, caching...');
          this.earlyStream = stream;
        }
      };

      this.pc.ondatachannel = (event) => {
        console.log('[WebRTC] Data channel established');
        this.dataChannel = event.channel;
        this.dataChannel.onmessage = (e) => {
          if (this.onData) this.onData(JSON.parse(e.data));
        };
      };
    }
  }

  async createStudentConnection(studentId) {
    if (!this.isTeacher) return;
    
    if (!this.stream) {
      console.log(`[WebRTC] Stream not ready. Queuing student: ${studentId}`);
      this.pendingStudents.push(studentId);
      return;
    }
    
    console.log(`[WebRTC] Creating PeerConnection for student: ${studentId}`);
    const pc = new RTCPeerConnection(this.config);
    this.setupPCListeners(pc, `Peer-${studentId}`);
    
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
    
    const dataChannel = pc.createDataChannel('cursorUpdates', { ordered: false, maxRetransmits: 0 });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Teacher Candidate for ${studentId}: ${event.candidate.candidate.substring(0, 60)}...`);
        this.signaling.sendIceCandidate(this.roomCode, event.candidate, studentId);
      } else {
        console.log(`[ICE] Teacher Gathering complete for ${studentId}`);
      }
    };
    
    this.peers.set(studentId, { pc, dataChannel, candidateQueue: [] });
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    console.log(`[SDP] Teacher Offer (Local):`, pc.localDescription.sdp.substring(0, 100) + '...');
    
    this.signaling.sendOffer(this.roomCode, studentId, offer);
    console.log(`[WebRTC] Offer sent to ${studentId}`);
  }

  async handleOffer(offer) {
    if (!this.pc) return;
    try {
      console.log('[WebRTC] Processing incoming Offer...');
      await this.pc.setRemoteDescription(offer);
      console.log('[WebRTC] Remote Description set (Offer)');
      
      while (this.candidateQueue.length > 0) {
        const candidate = this.candidateQueue.shift();
        await this.pc.addIceCandidate(candidate);
      }

      if (this.earlyStream && this.onStream) {
        console.log('[WebRTC] Releasing cached early stream');
        this.onStream(this.earlyStream);
        this.earlyStream = null;
      }

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      
      console.log(`[SDP] Student Answer (Local):`, this.pc.localDescription.sdp.substring(0, 100) + '...');
      
      this.signaling.send('ANSWER', this.roomCode, answer);
      console.log('[WebRTC] Answer sent');
    } catch (err) {
      console.error('[WebRTC] handleOffer failed:', err);
    }
  }

  async handleAnswer(answer, studentId) {
    if (!this.isTeacher || !this.peers.has(studentId)) return;
    try {
      const peer = this.peers.get(studentId);
      console.log(`[WebRTC] Processing Answer from student ${studentId}...`);
      await peer.pc.setRemoteDescription(answer);
      console.log(`[WebRTC] Remote Description set for ${studentId} (Answer stable)`);

      while (peer.candidateQueue.length > 0) {
        const candidate = peer.candidateQueue.shift();
        await peer.pc.addIceCandidate(candidate);
      }
    } catch (err) {
      console.error(`[WebRTC] handleAnswer failed for ${studentId}:`, err);
    }
  }

  async handleIceCandidate(candidate, studentId) {
    if (!candidate) return;
    try {
      console.log(`[ICE] handleIceCandidate from ${studentId}`);
      if (this.isTeacher && studentId && this.peers.has(studentId)) {
        const peer = this.peers.get(studentId);
        if (peer.pc.remoteDescription) {
          console.log(`[ICE] Adding student candidate for ${studentId}`);
          await peer.pc.addIceCandidate(candidate);
        } else {
          console.log(`[WebRTC] Queuing ICE candidate for student ${studentId}`);
          peer.candidateQueue.push(candidate);
        }
      } else if (!this.isTeacher && this.pc) {
        if (this.pc.remoteDescription) {
          console.log('[ICE] Adding teacher candidate');
          await this.pc.addIceCandidate(candidate);
        } else {
          console.log('[WebRTC] Queuing ICE candidate (Student)');
          this.candidateQueue.push(candidate);
        }
      }
    } catch (err) {
      console.error('[WebRTC] Failed to add ICE candidate:', err);
    }
  }

  setLocalPeerId(id) {
    this.localPeerId = id;
  }

  onStudentLeft(studentId) {
    const peer = this.peers.get(studentId);
    if (!peer) return;
    if (peer.dataChannel) peer.dataChannel.close();
    peer.pc.close();
    this.peers.delete(studentId);
    console.log(`[WebRTC] Peer ${studentId} removed`);
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
      this.pendingStudents = [];
    } else if (this.pc) {
      this.pc.close();
      this.earlyStream = null;
    }
    console.log('[WebRTC] Connection cleanup complete');
  }
}
