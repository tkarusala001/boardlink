import SignalingClient from './signaling.js';
import WebRTCClient from './webrtc.js';
import CursorGlow from './ui/CursorGlow.js';
import PipHold from './ui/PipHold.js';
import FocusPane from './ui/FocusPane.js';

// DOM Elements
const views = {
  landing: document.getElementById('view-landing'),
  teacher: document.getElementById('view-teacher'),
  studentJoin: document.getElementById('view-student-join'),
  studentLive: document.getElementById('view-student-live')
};

const btns = {
  shareStart: document.getElementById('btn-share-start'),
  joinStart: document.getElementById('btn-join-start'),
  joinConfirm: document.getElementById('btn-join-confirm'),
  backToLanding: document.getElementById('btn-back-to-landing'),
  endSession: document.getElementById('btn-end-session')
};

const inputs = {
  roomCode: document.getElementById('input-room-code')
};

const status = {
  roomCode: document.getElementById('room-code-display'),
  studentCount: document.getElementById('student-count-badge'),
  joinError: document.getElementById('join-error')
};

// State
let signaling = null;
let rtc = null;
let currentRoomCode = null;
let cursorGlow = null;
let pipHold = null;
let currentPalette = 'default';
let currentFilter = 'none';
let processingWorker = null;
let focusWorker = null;
let focusPane = null;
let processingInFlight = false;

const srAnnouncer = document.getElementById('sr-announcer');
function announce(msg) {
  srAnnouncer.textContent = '';
  requestAnimationFrame(() => { srAnnouncer.textContent = msg; }); // re-trigger on dupes
}

// Ordered filter cycle for Shift+F shortcut
const FILTER_CYCLE = ['none', 'light', 'medium', 'heavy'];

function showView(viewName) {
  Object.values(views).forEach(v => v.style.display = 'none');
  views[viewName].style.display = 'block';
  views[viewName].parentElement.style.display = 'flex';
}

// Initial Landing Logic
btns.shareStart.onclick = async () => {
  await initSignaling();
  signaling.send('CREATE_ROOM');
};

btns.joinStart.onclick = () => {
  showView('studentJoin');
  inputs.roomCode.focus();
};

btns.backToLanding.onclick = () => showView('landing');

btns.joinConfirm.onclick = async () => {
  const code = inputs.roomCode.value.toUpperCase();
  if (code.length !== 4) return;
  
  await initSignaling();
  signaling.joinRoom(code);
};

btns.endSession.onclick = () => {
  // Clear stored session so a page reload doesn't auto-rejoin
  sessionStorage.removeItem('bl_session_id');
  sessionStorage.removeItem('bl_room_code');
  const monitor = document.getElementById('teacher-monitor');
  if (monitor) monitor.style.display = 'none';
  if (rtc) rtc.close();
  if (signaling) signaling.close();
  location.reload();
};

async function initSignaling() {
  if (signaling) return;
  // Use Fly.io endpoint in production, localhost in development
  const signalingUrl = process.env.NODE_ENV === 'production'
    ? 'wss://boardlink.fly.dev'
    : 'ws://localhost:8082';
  signaling = new SignalingClient(signalingUrl);
  
  signaling.onMessage = async (msg) => {
    try {
      const { type, roomCode, payload, message, peerId } = msg;

      switch (type) {
        case 'ROOM_CREATED':
          currentRoomCode = roomCode;
          status.roomCode.innerText = roomCode;
          showView('teacher');
          await startTeacherSession(roomCode);
          break;

        case 'JOIN_SUCCESS':
          currentRoomCode = roomCode;
          if (msg.sessionId) sessionStorage.setItem('bl_session_id', msg.sessionId);
          if (msg.roomCode)  sessionStorage.setItem('bl_room_code',  msg.roomCode);
          showView('studentLive');
          if (rtc) rtc.setLocalPeerId(peerId);
          await startStudentSession(roomCode);
          announce('Connected to classroom session.');
          break;

        case 'STUDENT_JOINED':
          status.studentCount.innerText = `${msg.studentCount} Students Connected`;
          if (rtc) await rtc.createStudentConnection(peerId);
          announce(`Student connected. ${msg.studentCount} total.`);
          break;

        case 'STUDENT_LEFT':
          status.studentCount.innerText = `${msg.studentCount} Students Connected`;
          if (rtc) rtc.onStudentLeft(peerId);
          announce(`Student disconnected. ${msg.studentCount} remaining.`);
          break;

        case 'STUDENT_REJOINED':
          status.studentCount.innerText = `${msg.studentCount} Students Connected`;
          if (rtc) await rtc.createStudentConnection(peerId);
          break;

        case 'OFFER':
          if (rtc) await rtc.handleOffer(payload);
          break;

        case 'ANSWER':
          if (rtc) await rtc.handleAnswer(payload, peerId);
          break;

        case 'ICE_CANDIDATE':
          if (rtc) await rtc.handleIceCandidate(payload, peerId);
          break;

        case 'REJOIN_SUCCESS':
          if (msg.sessionId) sessionStorage.setItem('bl_session_id', msg.sessionId);
          if (rtc) rtc.setLocalPeerId(peerId);
          announce('Reconnected to classroom session.');
          status.joinError.style.display = 'none';
          break;

        case 'ERROR':
          status.joinError.innerText = message;
          status.joinError.style.display = 'block';
          break;
      }
    } catch (err) {
      console.error('Failed to process signaling message:', err);
    }
  };

  signaling.onObsoleteClient = (msg) => {
    status.joinError.innerText = `⚠️ ${msg}`;
    status.joinError.style.display = 'block';
    status.joinError.style.backgroundColor = 'var(--accent-danger, #e74c3c)';
    status.joinError.style.color = 'white';
    announce('Connection error: ' + msg);
  };

  signaling.onReconnecting = (attempt) => {
    status.joinError.innerText = `Signaling lost. Reconnecting (Attempt ${attempt})...`;
    status.joinError.style.display = 'block';
    status.joinError.style.backgroundColor = 'var(--accent-secondary)';
    status.joinError.style.color = 'black';
    announce(`Connection lost. Reconnect attempt ${attempt}.`);
  };

  signaling.onOpen = () => {
    status.joinError.style.display = 'none';
    const storedSession = sessionStorage.getItem('bl_session_id');
    const storedRoom    = sessionStorage.getItem('bl_room_code');
    if (storedSession && storedRoom && signaling.reconnectAttempts > 0) {
      signaling.rejoinRoom(storedRoom, storedSession);
    }
  };

  try {
    await signaling.connect();
  } catch (err) {
    console.error('Signaling connection failed:', err);
    status.joinError.innerText = "Cannot reach signaling server. Please check your connection.";
    status.joinError.style.display = 'block';
  }
}

async function startTeacherSession(code) {
  try {
    rtc = new WebRTCClient(signaling, true);
    await rtc.start(code);
    announce('Screen sharing started. Waiting for students.');

    // Wire up teacher monitor preview
    const monitor = document.getElementById('teacher-monitor');
    const previewVideo = document.getElementById('teacher-preview-video');
    if (monitor && previewVideo && rtc.stream) {
      previewVideo.srcObject = rtc.stream;
      previewVideo.muted = true;
      previewVideo.playsInline = true;
      previewVideo.play().catch(e => console.warn('[Teacher] preview play failed:', e));
      monitor.style.display = 'block';
      startMonitorDiagnostics();
    }

    window.addEventListener('mousemove', (e) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      rtc.sendCursor(x, y);
    });
  } catch (err) {
    console.error('Failed to start teacher session:', err);
    alert('Failed to start screen share. Please ensure you are on localhost or HTTPS.');
    location.reload();
  }
}

function startMonitorDiagnostics() {
  const streamInfoEl = document.getElementById('monitor-stream-info');
  const diagEl = document.getElementById('monitor-diag');
  if (!diagEl) return;

  function update() {
    if (!rtc) return;

    // Stream resolution/fps
    const track = rtc.stream?.getVideoTracks()[0];
    if (track && streamInfoEl) {
      const s = track.getSettings();
      streamInfoEl.textContent = s.width ? `${s.width}×${s.height} ${(s.frameRate || 0).toFixed(0)}fps` : '';
    }

    // Per-peer connection states
    const lines = [];
    if (rtc.peers.size === 0) {
      lines.push('No students connected yet');
    } else {
      for (const [id, peer] of rtc.peers) {
        const state = peer.pc.connectionState;
        const ice = peer.pc.iceConnectionState;
        const icon = state === 'connected' ? '●' : state === 'connecting' ? '◌' : state === 'failed' ? '✕' : '○';
        lines.push(`${icon} ${id.slice(0, 6)}  conn:${state}  ice:${ice}`);
      }
    }
    diagEl.textContent = lines.join('\n');

    requestAnimationFrame(update);
  }
  update();
}

async function startStudentSession(code) {
  rtc = new WebRTCClient(signaling, false);
  
  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('canvas-main');
  const ctx = canvas.getContext('2d');

  cursorGlow = new CursorGlow(viewport);
  cursorGlow.applySettings();
  
  pipHold = new PipHold(canvas, viewport);

  processingWorker = new Worker(new URL('./workers/processing-worker.js', import.meta.url), { type: 'module' });
  
  focusWorker = new Worker(new URL('./workers/focus-worker.js', import.meta.url), { type: 'module' });
  focusWorker.onmessage = (e) => {
    if (e.data.type === 'FOCUS_RESULT') {
      const { cx, cy, confidence } = e.data.payload;
      if (focusPane) focusPane.setTarget(cx, cy, confidence);
    }
  };

  processingWorker.onmessage = (e) => {
    if (e.data.type === 'FRAME_PROCESSED') {
      processingInFlight = false;
      if (currentFilter !== 'none') {
        ctx.putImageData(e.data.payload.imageData, 0, 0);
      }
    }
  };

  // Show connecting overlay until stream arrives
  const overlayStatus = document.getElementById('overlay-status');
  const overlayMsg = document.getElementById('overlay-msg');
  if (overlayStatus) { overlayStatus.style.display = 'block'; overlayMsg.textContent = 'Waiting for stream…'; }

  rtc.onStream = (stream) => {
    if (overlayStatus) overlayStatus.style.display = 'none';
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(err => console.error('[Student] video.play() failed:', err));

    const thumbCanvas = document.createElement('canvas');
    let thumbCtx = null;

    // Rendering loop
    const render = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // Init on first frame or dimension change
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          thumbCanvas.width = Math.floor(video.videoWidth / 10);
          thumbCanvas.height = Math.floor(video.videoHeight / 10);
          thumbCtx = thumbCanvas.getContext('2d');
          focusWorker.postMessage({ type: 'INIT', payload: { width: canvas.width, height: canvas.height } });

          focusPane = new FocusPane(
            video,
            document.getElementById('canvas-focus'),
            document.getElementById('canvas-thumb'),
            document.getElementById('thumb-highlight')
          );
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        if (currentFilter !== 'none' && !processingInFlight) {
          processingInFlight = true;
          createImageBitmap(video).then(bitmap => {
            processingWorker.postMessage({
              type: 'PROCESS_FRAME_BITMAP',
              payload: { bitmap, filterLevel: currentFilter, palette: currentPalette }
            }, [bitmap]);
          });
        }

        // Send every other frame to focus worker
        if (Math.random() > 0.5 && thumbCtx) {
          thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
          const thumbData = thumbCtx.getImageData(0, 0, thumbCanvas.width, thumbCanvas.height);
          focusWorker.postMessage({ type: 'PROCESS_FRAME', payload: { imageData: thumbData } });
        }

        canvas.className = currentPalette !== 'default' ? `palette-${currentPalette}` : '';
      }
      requestAnimationFrame(render);
    };
    render();
  };

  rtc.onData = (data) => {
    if (data.type === 'CURSOR') {
      if (cursorGlow) cursorGlow.moveTo(data.x, data.y);
      if (focusWorker) focusWorker.postMessage({ type: 'PROCESS_CURSOR', payload: { x: data.x, y: data.y } });
    }
  };

  await rtc.start(code);

  document.getElementById('palette-selector').onchange = (e) => {
    currentPalette = e.target.value;
  };

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
    };
  });

  const settingsPanel = document.getElementById('settings-panel');
  const settingsBtn = document.getElementById('btn-student-settings');
  settingsBtn.onclick = () => {
    const open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'grid';
    settingsBtn.setAttribute('aria-expanded', String(!open));
  };

  document.getElementById('btn-freeze-frame').onclick = () => {
    if (pipHold) pipHold.capture();
  };

  document.getElementById('btn-toggle-focus').onclick = () => {
    const pane = document.getElementById('focus-pane');
    pane.style.display = pane.style.display === 'none' ? 'block' : 'none';
  };

  const focusThumbnail = document.getElementById('focus-thumbnail');
  focusThumbnail.onclick = (e) => {
    if (!focusPane) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    focusPane.toggleAuto(false);
    focusPane.targetX = nx;
    focusPane.targetY = ny;
  };

  focusThumbnail.addEventListener('keydown', (e) => {
    if (!focusPane) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focusPane.toggleAuto(true);
      announce('Focus mode set to automatic.');
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (pipHold) pipHold.capture();
      announce('Frame frozen.');
    }

    if (e.shiftKey && e.key.toUpperCase() === 'F') {
      e.preventDefault();
      const idx = FILTER_CYCLE.indexOf(currentFilter);
      currentFilter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === currentFilter);
      });
      announce(`Filter: ${currentFilter}`);
    }
  });
}
