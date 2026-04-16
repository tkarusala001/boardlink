/**
 * CaptureGallery — sidebar list of frozen frames + fullscreen viewer with
 * download / annotate (color brush + eraser) / close controls.
 *
 * Public API:
 *   new CaptureGallery(sourceCanvas)
 *   .capture()        snapshot the source canvas → push to sidebar
 *   .open(id)         open a capture in fullscreen viewer
 *   .close()          close the active viewer
 *   .destroy()        tear down all DOM + listeners
 */

const COLORS = ['#ffcc00', '#ffffff', '#000000', '#e74c3c', '#00e0ff', '#73daca', '#c084fc'];

const ICON = {
  download: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  annotate: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16a2 2 0 0 1 0-2.83l9.17-9.17a2 2 0 0 1 2.83 0l5 5a2 2 0 0 1 0 2.83L11 20"/><line x1="18" y1="13" x2="9" y2="4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
};

export default class CaptureGallery {
  constructor(sourceCanvas) {
    this.sourceCanvas = sourceCanvas;
    this.captures = [];
    this.activeViewer = null;
    this._buildSidebar();
  }

  _buildSidebar() {
    const sidebar = document.createElement('aside');
    sidebar.id = 'capture-sidebar';
    sidebar.className = 'capture-sidebar';
    sidebar.setAttribute('aria-label', 'Captured frames');
    sidebar.hidden = true;
    sidebar.innerHTML = `
      <div class="capture-sidebar__header">
        <span class="capture-sidebar__title">Captures</span>
        <span class="capture-sidebar__count" data-count>0</span>
      </div>
      <div class="capture-sidebar__list" data-list role="list"></div>
      <div class="capture-sidebar__empty" data-empty>
        <p>No captures yet.</p>
        <p class="capture-sidebar__hint">Press <kbd>Space</kbd> or click <strong>Freeze</strong>.</p>
      </div>
    `;
    document.body.appendChild(sidebar);
    this.sidebar = sidebar;
    this.listEl = sidebar.querySelector('[data-list]');
    this.countEl = sidebar.querySelector('[data-count]');
    this.emptyEl = sidebar.querySelector('[data-empty]');
  }

  capture() {
    const src = this.sourceCanvas;
    if (!src || !src.width || !src.height) return;

    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    off.getContext('2d').drawImage(src, 0, 0);

    const item = {
      id: `cap-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      dataUrl: off.toDataURL('image/png'),
      width: src.width,
      height: src.height,
      time: new Date(),
    };

    this.captures.unshift(item);
    this._renderList();
    this._showSidebar();
  }

  _renderList() {
    this.countEl.textContent = String(this.captures.length);
    this.listEl.innerHTML = '';
    this.emptyEl.hidden = this.captures.length > 0;

    for (const cap of this.captures) {
      const card = document.createElement('div');
      card.className = 'capture-thumb';
      card.setAttribute('role', 'listitem');

      const openBtn = document.createElement('button');
      openBtn.className = 'capture-thumb__open';
      openBtn.setAttribute('aria-label', `View capture from ${cap.time.toLocaleTimeString()}`);
      openBtn.innerHTML = `
        <img src="${cap.dataUrl}" alt="Captured frame" loading="lazy" draggable="false" />
        <div class="capture-thumb__meta">
          <span class="capture-thumb__time">${cap.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <span class="capture-thumb__dim">${cap.width}×${cap.height}</span>
        </div>
      `;
      openBtn.addEventListener('click', () => this.open(cap.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'capture-thumb__delete';
      delBtn.setAttribute('aria-label', 'Delete capture');
      delBtn.innerHTML = ICON.trash;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._delete(cap.id);
      });

      card.appendChild(openBtn);
      card.appendChild(delBtn);
      this.listEl.appendChild(card);
    }
  }

  _delete(id) {
    this.captures = this.captures.filter(c => c.id !== id);
    this._renderList();
  }

  _showSidebar() {
    this.sidebar.hidden = false;
    requestAnimationFrame(() => this.sidebar.classList.add('is-open'));
  }

  open(id) {
    const cap = this.captures.find(c => c.id === id);
    if (!cap) return;
    if (this.activeViewer) this.close();
    this.activeViewer = this._buildViewer(cap);
    document.body.appendChild(this.activeViewer.root);
    requestAnimationFrame(() => {
      this.activeViewer.root.classList.add('is-open');
      this.activeViewer.fitImage();
    });
  }

  close() {
    if (!this.activeViewer) return;
    const v = this.activeViewer;
    v.cleanup();
    v.root.classList.remove('is-open');
    setTimeout(() => v.root.remove(), 300);
    this.activeViewer = null;
  }

  _buildViewer(cap) {
    const root = document.createElement('div');
    root.className = 'capture-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Capture viewer');

    root.innerHTML = `
      <div class="capture-viewer__stage" data-stage>
        <div class="capture-viewer__canvas-wrap" data-wrap>
          <canvas class="capture-viewer__image" data-image></canvas>
          <canvas class="capture-viewer__draw" data-draw></canvas>
        </div>
      </div>
      <div class="capture-viewer__toolbar" role="toolbar" aria-label="Capture tools">
        <div class="capture-viewer__tools">
          <button class="cv-btn" data-act="download">
            ${ICON.download}<span>Download</span>
          </button>
          <button class="cv-btn" data-act="annotate" aria-pressed="false">
            ${ICON.annotate}<span>Annotate</span>
          </button>
          <div class="cv-annotate-tools" data-tools hidden>
            <div class="cv-colors" role="radiogroup" aria-label="Brush color">
              ${COLORS.map((c, i) => `
                <button class="cv-color${i === 0 ? ' is-active' : ''}" data-color="${c}" style="--c:${c}" aria-label="Color ${c}"></button>
              `).join('')}
            </div>
            <button class="cv-btn cv-btn--small" data-act="eraser" aria-pressed="false">
              ${ICON.eraser}<span>Eraser</span>
            </button>
            <button class="cv-btn cv-btn--small cv-btn--ghost" data-act="clear">Clear</button>
          </div>
        </div>
        <button class="cv-btn cv-btn--close" data-act="close" aria-label="Close viewer">
          ${ICON.close}
        </button>
      </div>
    `;

    const stage = root.querySelector('[data-stage]');
    const wrap = root.querySelector('[data-wrap]');
    const imageCanvas = root.querySelector('[data-image]');
    const drawCanvas = root.querySelector('[data-draw]');
    const toolsEl = root.querySelector('[data-tools]');
    const annotateBtn = root.querySelector('[data-act="annotate"]');
    const eraserBtn = root.querySelector('[data-act="eraser"]');

    imageCanvas.width = cap.width;
    imageCanvas.height = cap.height;
    drawCanvas.width = cap.width;
    drawCanvas.height = cap.height;

    const img = new Image();
    img.onload = () => imageCanvas.getContext('2d').drawImage(img, 0, 0);
    img.src = cap.dataUrl;

    const dctx = drawCanvas.getContext('2d');
    dctx.lineCap = 'round';
    dctx.lineJoin = 'round';

    const state = {
      annotating: false,
      tool: 'brush',
      color: COLORS[0],
      drawing: false,
    };

    // ---- size the canvas wrap so getBoundingClientRect maps cleanly to canvas px
    const fitImage = () => {
      const sr = stage.getBoundingClientRect();
      const padX = 32, padY = 24;
      const availW = Math.max(0, sr.width - padX);
      const availH = Math.max(0, sr.height - padY);
      const ar = cap.width / cap.height;
      let w, h;
      if (availW / availH > ar) {
        h = availH; w = h * ar;
      } else {
        w = availW; h = w / ar;
      }
      wrap.style.width = `${Math.floor(w)}px`;
      wrap.style.height = `${Math.floor(h)}px`;
    };
    const onResize = () => fitImage();
    window.addEventListener('resize', onResize);

    // ---- annotate toggle
    const setAnnotate = (on) => {
      state.annotating = on;
      toolsEl.hidden = !on;
      annotateBtn.classList.toggle('is-active', on);
      annotateBtn.setAttribute('aria-pressed', String(on));
      wrap.classList.toggle('is-annotating', on);
      if (!on) {
        state.tool = 'brush';
        eraserBtn.classList.remove('is-active');
        eraserBtn.setAttribute('aria-pressed', 'false');
        wrap.classList.remove('is-erasing');
      }
    };
    annotateBtn.addEventListener('click', () => setAnnotate(!state.annotating));

    // ---- eraser toggle
    eraserBtn.addEventListener('click', () => {
      state.tool = state.tool === 'eraser' ? 'brush' : 'eraser';
      const on = state.tool === 'eraser';
      eraserBtn.classList.toggle('is-active', on);
      eraserBtn.setAttribute('aria-pressed', String(on));
      wrap.classList.toggle('is-erasing', on);
    });

    // ---- color pick
    root.querySelectorAll('.cv-color').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.cv-color').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.color = btn.dataset.color;
        state.tool = 'brush';
        eraserBtn.classList.remove('is-active');
        eraserBtn.setAttribute('aria-pressed', 'false');
        wrap.classList.remove('is-erasing');
      });
    });

    // ---- clear
    root.querySelector('[data-act="clear"]').addEventListener('click', () => {
      dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    });

    // ---- download (composite of image + annotations)
    root.querySelector('[data-act="download"]').addEventListener('click', () => {
      const out = document.createElement('canvas');
      out.width = imageCanvas.width;
      out.height = imageCanvas.height;
      const octx = out.getContext('2d');
      octx.drawImage(imageCanvas, 0, 0);
      octx.drawImage(drawCanvas, 0, 0);
      const ts = cap.time.toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const a = document.createElement('a');
      a.href = out.toDataURL('image/png');
      a.download = `boardlink-capture-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    // ---- close
    root.querySelector('[data-act="close"]').addEventListener('click', () => this.close());

    // ---- drawing
    const getPos = (e) => {
      const rect = drawCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * drawCanvas.width;
      const y = ((e.clientY - rect.top) / rect.height) * drawCanvas.height;
      return { x, y };
    };

    const start = (e) => {
      if (!state.annotating) return;
      e.preventDefault();
      drawCanvas.setPointerCapture?.(e.pointerId);
      const { x, y } = getPos(e);
      state.drawing = true;
      dctx.globalCompositeOperation = state.tool === 'eraser' ? 'destination-out' : 'source-over';
      dctx.strokeStyle = state.color;
      // brush size scales with image so feel is consistent across resolutions
      dctx.lineWidth = state.tool === 'eraser'
        ? Math.max(18, drawCanvas.width / 80)
        : Math.max(3, drawCanvas.width / 480);
      dctx.beginPath();
      dctx.moveTo(x, y);
      // Draw a tiny dot so single-clicks register
      dctx.lineTo(x + 0.01, y + 0.01);
      dctx.stroke();
    };
    const move = (e) => {
      if (!state.drawing) return;
      const { x, y } = getPos(e);
      dctx.lineTo(x, y);
      dctx.stroke();
    };
    const end = (e) => {
      if (!state.drawing) return;
      state.drawing = false;
      dctx.closePath();
      try { drawCanvas.releasePointerCapture?.(e.pointerId); } catch {}
    };

    drawCanvas.addEventListener('pointerdown', start);
    drawCanvas.addEventListener('pointermove', move);
    drawCanvas.addEventListener('pointerup', end);
    drawCanvas.addEventListener('pointercancel', end);

    // ---- ESC closes
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    };
    document.addEventListener('keydown', keyHandler);

    const cleanup = () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', keyHandler);
    };

    return { root, fitImage, cleanup };
  }

  destroy() {
    this.close();
    this.sidebar?.remove();
    this.captures = [];
  }
}
