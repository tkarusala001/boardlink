export default class WebRTCClient {
  constructor(signaling, isTeacher = false) {
    this.signaling = signaling;
    this.isTeacher = isTeacher;
    this.roomCode = null;
    
    // Teacher state
    this.peers = new Map(); // studentId -> { pc, dataChannel }
    this.stream = null;
    
    // Student state
    this.pc = null;
    this.onStream = null;
    this.dataChannel = null;
    this.onData = null;

    this.config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  async start(roomCode) {
    this.roomCode = roomCode;

    if (this.isTeacher) {
      // Capture screen
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 10, max: 15 }
        },
        audio: false
      });
      // teacher waits; connections created in createStudentConnection()
    } else {
      // Student side
      this.pc = new RTCPeerConnection(this.config);

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signaling.send('ICE_CANDIDATE', this.roomCode, event.candidate, null);
        }
      };

      this.pc.ontrack = (event) => {
        if (this.onStream) this.onStream(event.streams[0]);
      };

      this.pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Student connection state: ${this.pc.connectionState}`);
        if (this.pc.connectionState === 'failed') {
          console.warn('[WebRTC] ICE failed on student side');
        }
      };

      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.onmessage = (e) => {
          if (this.onData) this.onData(JSON.parse(e.data));
        };
      };
    }
  }

  async createStudentConnection(studentId) {
    if (!this.isTeacher || !this.stream) return;
    
    const pc = new RTCPeerConnection(this.config);
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
    
    // unreliable, for cursor updates
    const dataChannel = pc.createDataChannel('cursorUpdates', { ordered: false, maxRetransmits: 0 });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.roomCode, event.candidate, studentId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Teacher -> Student ${studentId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.warn(`[WebRTC] failed for ${studentId}, restarting ICE`);
        pc.restartIce();
      }
    };
    
    this.peers.set(studentId, { pc, dataChannel });
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.roomCode, studentId, offer);
  }

  async handleOffer(offer) {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(offer);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signaling.send('ANSWER', this.roomCode, answer);
    } catch (err) {
      console.error('[WebRTC] Failed to handle offer:', err);
    }
  }

  async handleAnswer(answer, studentId) {
    if (!this.isTeacher || !this.peers.has(studentId)) return;
    try {
      await this.peers.get(studentId).pc.setRemoteDescription(answer);
    } catch (err) {
      console.error(`[WebRTC] Failed to handle answer for ${studentId}:`, err);
    }
  }

  async handleIceCandidate(candidate, studentId) {
    if (!candidate) return;
    try {
      if (this.isTeacher && studentId && this.peers.has(studentId)) {
        await this.peers.get(studentId).pc.addIceCandidate(candidate);
      } else if (!this.isTeacher && this.pc) {
        await this.pc.addIceCandidate(candidate);
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
