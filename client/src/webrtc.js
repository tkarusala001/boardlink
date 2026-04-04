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

    this.config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  async start(roomCode) {
    this.roomCode = roomCode;
    this.pc = new RTCPeerConnection(this.config);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.roomCode, event.candidate);
      }
    };

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

      this.stream.getTracks().forEach(track => this.pc.addTrack(track, this.stream));

      // Setup DataChannel for cursor (REQ-010: 60Hz)
      this.dataChannel = this.pc.createDataChannel('cursorUpdates', { ordered: false });
      this.dataChannel.onopen = () => console.log('Data channel opened');
      
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.sendOffer(this.roomCode, offer);

    } else {
      // Student side
      this.pc.ontrack = (event) => {
        if (this.onStream) this.onStream(event.streams[0]);
      };

      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.onmessage = (e) => {
          if (this.onData) this.onData(JSON.parse(e.data));
        };
      };
    }
  }

  async handleOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendIceCandidate(this.roomCode, null); // Anchor
    this.signaling.sendAnswer(this.roomCode, answer);
  }

  async handleAnswer(answer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleIceCandidate(candidate) {
    if (candidate) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  sendCursor(x, y) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'CURSOR', x, y }));
    }
  }

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.pc) {
      this.pc.close();
    }
  }
}
