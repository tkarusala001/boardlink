export default class WebRTCClient {
  constructor(signaling, isTeacher = false) {
    this.signaling = signaling;
    this.pc = null;
    this.stream = null;
    this.onStream = null;
    this.isTeacher = isTeacher;
    this.dataChannel = null;
    this.onData = null;
    this.roomCode = null;
    this.peerConnections = new Map();
    this.dataChannels = new Map();
    this.localPeerId = null;

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
      // REQ-007: 10fps target, 1080p
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 10, max: 15 }
        },
        audio: false
      });
    } else {
      // Student side
      this.createStudentPeerConnection();
    }
  }

  createStudentPeerConnection() {
    this.pc = new RTCPeerConnection(this.config);
    this.pc.ontrack = (event) => {
      if (this.onStream) this.onStream(event.streams[0]);
    };
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.dataChannel.onmessage = (e) => {
        if (this.onData) this.onData(JSON.parse(e.data));
      };
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.roomCode, event.candidate);
      }
    };
  }

  async createTeacherPeerConnection(targetPeerId) {
    if (!this.stream) return;
    if (this.peerConnections.has(targetPeerId)) return;

    const pc = new RTCPeerConnection(this.config);
    this.peerConnections.set(targetPeerId, pc);

    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));

    const dc = pc.createDataChannel('cursorUpdates', { ordered: false });
    dc.onopen = () => console.log(`Data channel opened for ${targetPeerId}`);
    this.dataChannels.set(targetPeerId, dc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.roomCode, event.candidate, targetPeerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.roomCode, targetPeerId, offer);
  }

  async handleOffer(offer) {
    if (!this.pc) this.createStudentPeerConnection();
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.roomCode, answer);
  }

  async handleAnswer(answer, peerId) {
    if (!this.isTeacher) {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      return;
    }
    const pc = this.peerConnections.get(peerId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleIceCandidate(candidate, peerId = null) {
    if (candidate) {
      if (this.isTeacher) {
        const pc = this.peerConnections.get(peerId);
        if (!pc) return;
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else if (this.pc) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }
  }

  sendCursor(x, y) {
    if (this.isTeacher) {
      this.dataChannels.forEach((dc) => {
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({ type: 'CURSOR', x, y }));
        }
      });
      return;
    }
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'CURSOR', x, y }));
    }
  }

  removeTeacherPeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    this.dataChannels.delete(peerId);
  }

  setLocalPeerId(peerId) {
    this.localPeerId = peerId;
  }

  getConnectedCount() {
    return this.isTeacher ? this.peerConnections.size : (this.pc ? 1 : 0);
  }

  async onStudentJoined(peerId) {
    if (!this.isTeacher || !peerId) return;
    await this.createTeacherPeerConnection(peerId);
  }

  async onStudentLeft(peerId) {
    if (!this.isTeacher || !peerId) return;
    this.removeTeacherPeer(peerId);
  }

  async onSignalingAnswer(answer, peerId) {
    await this.handleAnswer(answer, peerId);
  }

  async onSignalingIceCandidate(candidate, peerId = null) {
    await this.handleIceCandidate(candidate, peerId);
  }

  async onSignalingOffer(offer) {
    await this.handleOffer(offer);
  }

  resetTeacherPeers() {
    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();
    this.dataChannels.clear();
  }

  async replaceTracksForTeacher() {
    if (!this.isTeacher || !this.stream) return;
    this.peerConnections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'video') {
          const nextTrack = this.stream.getVideoTracks()[0];
          if (nextTrack) sender.replaceTrack(nextTrack).catch(() => {});
        }
      });
    });
  }

  async restartTeacherOffers() {
    if (!this.isTeacher) return;
    for (const [peerId, pc] of this.peerConnections.entries()) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer(this.roomCode, peerId, offer);
    }
  }

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.pc) this.pc.close();
    if (this.isTeacher) {
      this.peerConnections.forEach((pc) => pc.close());
      this.peerConnections.clear();
      this.dataChannels.clear();
    }
  }
}
