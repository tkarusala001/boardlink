const PROTOCOL_VERSION = 1;

export default class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
    this.onReconnecting = null;
    this.onObsoleteClient = null; // Called when server rejects client as outdated
    
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.isManualClose = false;
    this.messageQueue = [];
  }

  createRoom() {
    this.send('CREATE_ROOM');
  }

  joinRoom(roomCode) {
    this.send('JOIN_ROOM', roomCode);
  }

  rejoinRoom(roomCode, sessionId) {
    this.send('REJOIN_ROOM', roomCode, { sessionId });
  }

  sendOffer(roomCode, targetPeerId, offer) {
    this.send('OFFER', roomCode, { targetPeerId, offer });
  }

  sendAnswer(roomCode, answer) {
    this.send('ANSWER', roomCode, answer);
  }

  sendIceCandidate(roomCode, candidate, targetPeerId = null) {
    const payload = targetPeerId ? { targetPeerId, candidate } : candidate;
    this.send('ICE_CANDIDATE', roomCode, payload);
  }

  connect() {
    this.isManualClose = false;
    return new Promise((resolve, reject) => {
      console.log(`Connecting to signaling: ${this.url} (Port 8082 Migration)`);
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('Signaling connected');
        this.reconnectAttempts = 0;
        
        // Flush Queued Messages
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          this.ws.send(msg);
        }
        
        if (this.onOpen) this.onOpen();
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data.toString());
          // Handle server-side version rejection
          if (message.type === 'SYS_OBSOLETE_CLIENT') {
            console.error('[Signaling] Server rejected client as outdated:', message.message);
            if (this.onObsoleteClient) this.onObsoleteClient(message.message);
            this.isManualClose = true; // Don't auto-reconnect on version mismatch
            return;
          }
          if (this.onMessage) this.onMessage(message);
        } catch (err) {
          console.error('Failed to parse signaling message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('Signaling disconnected');
        if (this.onClose) this.onClose();
        if (!this.isManualClose) {
          this.reconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.error('Signaling error', err);
        // Don't reject if we are already trying to reconnect
        if (this.reconnectAttempts === 0) reject(err);
      };
    });
  }

  reconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
    
    console.log(`Attempting reconnection ${this.reconnectAttempts} in ${delay}ms...`);
    if (this.onReconnecting) this.onReconnecting(this.reconnectAttempts);
    
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  send(type, roomCode, payload = {}, targetId = null) {
    const msg = JSON.stringify({ v: PROTOCOL_VERSION, type, roomCode, payload, targetId });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      console.warn(`Buffering ${type}: Signaling not yet open.`);
      this.messageQueue.push(msg);
    }
  }

  close() {
    this.isManualClose = true;
    if (this.ws) this.ws.close();
  }
}
