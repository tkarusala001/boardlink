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

function showView(viewName) {
  Object.values(views).forEach(v => v.style.display = 'none');
  views[viewName].style.display = viewName === 'studentLive' ? 'block' : 'block'; // Adjust for flex/grid if needed
  if (viewName === 'studentLive') {
    views[viewName].parentElement.style.display = 'flex';
  } else {
    views[viewName].parentElement.style.display = 'flex';
  }
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
  signaling.send('JOIN_ROOM', code);
};

btns.endSession.onclick = () => {
  if (rtc) rtc.close();
  location.reload();
};

async function initSignaling() {
  if (signaling) return;
  signaling = new SignalingClient('ws://localhost:8082'); // Migrated to 8082 for reliability
  
  signaling.onMessage = async (msg) => {
    try {
      const { type, roomCode, payload, message } = msg;

      switch (type) {
        case 'ROOM_CREATED':
          currentRoomCode = roomCode;
          status.roomCode.innerText = roomCode;
          showView('teacher');
          await startTeacherSession(roomCode);
          break;

        case 'JOIN_SUCCESS':
          currentRoomCode = roomCode;
          showView('studentLive');
          await startStudentSession(roomCode);
          break;

        case 'STUDENT_JOINED':
          status.studentCount.innerText = `${payload || msg.studentCount} Students Connected`;
          break;

        case 'OFFER':
          if (rtc) await rtc.handleOffer(payload);
          break;

        case 'ANSWER':
          if (rtc) await rtc.handleAnswer(payload);
          break;

        case 'ICE_CANDIDATE':
          if (rtc) await rtc.handleIceCandidate(payload);
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

  signaling.onReconnecting = (attempt) => {
    status.joinError.innerText = `Signaling lost. Reconnecting (Attempt ${attempt})...`;
    status.joinError.style.display = 'block';
    status.joinError.style.backgroundColor = 'var(--accent-secondary)';
    status.joinError.style.color = 'black';
  };

  signaling.onOpen = () => {
    status.joinError.style.display = 'none';
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
    
    // Track cursor position (REQ-010: 60Hz)
    window.addEventListener('mousemove', (e) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      rtc.sendCursor(x, y);
    });
  } catch (err) {
    console.error('Failed to start teacher session:', err);
    alert('Failed to start screen share. Please ensure you are on localhost or HTTPS, and that you granted screen permissions.');
    location.reload();
  }
}

async function startStudentSession(code) {
  rtc = new WebRTCClient(signaling, false);
  
  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('canvas-main');
  const ctx = canvas.getContext('2d');

  cursorGlow = new CursorGlow(viewport);
  cursorGlow.applySettings(); // Initial apply
  
  pipHold = new PipHold(canvas, viewport);

  processingWorker = new Worker(new URL('./workers/processing-worker.js', import.meta.url), { type: 'module' });
  
  focusWorker = new Worker(new URL('./workers/focus-worker.js', import.meta.url), { type: 'module' });
  focusWorker.onmessage = (e) => {
    if (e.data.type === 'FOCUS_RESULT') {
      const { cx, cy, confidence } = e.data.payload;
      if (focusPane) focusPane.setTarget(cx, cy, confidence);
    }
  };

  // Removed transferControlToOffscreen to fix "Black Screen" (UI thread must own ctx)
  processingWorker.onmessage = (e) => {
    if (e.data.type === 'FRAME_PROCESSED' && currentFilter !== 'none') {
       ctx.putImageData(e.data.payload.imageData, 0, 0);
    }
  };

  rtc.onStream = (stream) => {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.play();
    
    // Rendering loop
    const render = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // Init Focus Worker if first frame
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          focusWorker.postMessage({ type: 'INIT', payload: { width: canvas.width, height: canvas.height } });
          
          focusPane = new FocusPane(
            video, // Updated to use video directly
            document.getElementById('canvas-focus'),
            document.getElementById('canvas-thumb'),
            document.getElementById('thumb-highlight')
          );
        }

        // 1. Base Draw (REQ-020: Lowest Latency)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // 2. Bold-Ink Processing (REQ-017 / REQ-018)
        if (currentFilter !== 'none') {
          // Get ImageData from current frame
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = canvas.width;
          tempCanvas.height = canvas.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(video, 0, 0);
          const imageData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);

          processingWorker.postMessage({
            type: 'PROCESS_FRAME',
            payload: { imageData, filterLevel: currentFilter, palette: currentPalette }
          });
        }
        
        // 3. Focus AI (REQ-001)
        if (Math.random() > 0.5) {
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = video.videoWidth / 10;
          thumbCanvas.height = video.videoHeight / 10;
          const thumbCtx = thumbCanvas.getContext('2d');
          thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
          const thumbData = thumbCtx.getImageData(0, 0, thumbCanvas.width, thumbCanvas.height);
          focusWorker.postMessage({ type: 'PROCESS_FRAME', payload: { imageData: thumbData } });
        }
        
        // Apply Palette Class
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

  // Setup Student UI Listeners
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

  document.getElementById('btn-freeze-frame').onclick = () => {
    if (pipHold) pipHold.capture();
  };

  document.getElementById('btn-toggle-focus').onclick = () => {
    const pane = document.getElementById('focus-pane');
    pane.style.display = pane.style.display === 'none' ? 'block' : 'none';
  };

  document.getElementById('focus-thumbnail').onclick = (e) => {
    if (!focusPane) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    
    focusPane.toggleAuto(false); // Manual override
    focusPane.targetX = nx;
    focusPane.targetY = ny;
    
    // Add a way to resume auto? Maybe double click or a 'Resume' button
  };
}
