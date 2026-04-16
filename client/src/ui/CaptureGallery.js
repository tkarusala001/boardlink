/**
 * CaptureGallery — sidebar list of frozen frames + fullscreen viewer with
 * download / multi-tool annotation (brush, highlight w/ opacity, text,
 * sticky notes, eraser) / close controls.
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
  brush: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  highlight: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l-6 6v3h3l6-6"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`,
  text: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  note: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8z"/><polyline points="14 3 14 9 20 9"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16a2 2 0 0 1 0-2.83l9.17-9.17a2 2 0 0 1 2.83 0l5 5a2 2 0 0 1 0 2.83L11 20"/><line x1="18" y1="13" x2="9" y2="4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  closeSm: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
};

const TOOLS = [
  { id: 'brush',     label: 'Brush',      icon: ICON.brush },
  { id: 'highlight', label: 'Highlight',  icon: ICON.highlight },
  { id: 'text',      label: 'Text',       icon: ICON.text },
  { id: 'note',      label: 'Sticky note',icon: ICON.note },
  { id: 'eraser',    label: 'Eraser',     icon: ICON.eraser },
];

export default class CaptureGallery {
  constructor(sourceCanvas) {
    this.sourceCanvas = sourceCanvas;
    this.captures = [];
    this.activeViewer = null;
    this.onSidebarToggle = null; // (isOpen: boolean) => void
    this._buildSidebar();
  }

  _emitSidebarState(isOpen) {
    try { this.onSidebarToggle?.(isOpen); } catch (err) { console.error(err); }
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
        <button class="capture-sidebar__close" data-close-sidebar aria-label="Hide captures sidebar" type="button">${ICON.closeSm}</button>
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

    sidebar.querySelector('[data-close-sidebar]')
      .addEventListener('click', () => this._hideSidebar());
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
      openBtn.type = 'button';
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
      delBtn.type = 'button';
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
    this._emitSidebarState(true);
  }

  _hideSidebar() {
    this.sidebar.classList.remove('is-open');
    setTimeout(() => {
      if (!this.sidebar.classList.contains('is-open')) this.sidebar.hidden = true;
    }, 380);
    this._emitSidebarState(false);
  }

  /** Toggle the sidebar — returns `true` when now open, `false` when now closed. */
  toggleSidebar() {
    const isOpen = !this.sidebar.hidden && this.sidebar.classList.contains('is-open');
    if (isOpen) { this._hideSidebar(); return false; }
    this._showSidebar();
    return true;
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

    const toolButtons = TOOLS.map((t, i) => `
      <button class="cv-tool${i === 0 ? ' is-active' : ''}" data-tool="${t.id}"
              aria-label="${t.label}" title="${t.label}" type="button">
        ${t.icon}
      </button>`).join('');

    const colorButtons = COLORS.map((c, i) => `
      <button class="cv-color${i === 0 ? ' is-active' : ''}" data-color="${c}"
              style="--c:${c}" aria-label="Color ${c}" type="button"></button>`).join('');

    root.innerHTML = `
      <div class="capture-viewer__stage" data-stage>
        <div class="capture-viewer__canvas-wrap" data-wrap data-tool="brush">
          <canvas class="capture-viewer__image" data-image></canvas>
          <canvas class="capture-viewer__draw" data-draw></canvas>
          <div class="cv-notes" data-notes></div>
        </div>
      </div>
      <div class="capture-viewer__toolbar" role="toolbar" aria-label="Capture tools">
        <div class="capture-viewer__tools">
          <button class="cv-btn" data-act="download" type="button">
            ${ICON.download}<span>Download</span>
          </button>
          <button class="cv-btn" data-act="annotate" aria-pressed="false" type="button">
            ${ICON.annotate}<span>Annotate</span>
          </button>
          <div class="cv-annotate-tools" data-tools hidden>
            <div class="cv-tool-group" role="radiogroup" aria-label="Annotation tool">
              ${toolButtons}
            </div>
            <div class="cv-colors" role="radiogroup" aria-label="Color">
              ${colorButtons}
            </div>
            <label class="cv-opacity" data-opacity hidden>
              <span>Opacity</span>
              <input type="range" min="10" max="100" value="35" data-opacity-input aria-label="Highlighter opacity" />
              <span class="cv-opacity__value" data-opacity-value>35%</span>
            </label>
            <button class="cv-btn cv-btn--small cv-btn--ghost" data-act="clear" type="button">Clear</button>
          </div>
        </div>
        <button class="cv-btn cv-btn--close" data-act="close" aria-label="Close viewer" type="button">
          ${ICON.close}
        </button>
      </div>
    `;

    const stage        = root.querySelector('[data-stage]');
    const wrap         = root.querySelector('[data-wrap]');
    const imageCanvas  = root.querySelector('[data-image]');
    const drawCanvas   = root.querySelector('[data-draw]');
    const notesLayer   = root.querySelector('[data-notes]');
    const toolsEl      = root.querySelector('[data-tools]');
    const annotateBtn  = root.querySelector('[data-act="annotate"]');
    const opacityWrap  = root.querySelector('[data-opacity]');
    const opacityInput = root.querySelector('[data-opacity-input]');
    const opacityValue = root.querySelector('[data-opacity-value]');

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
      opacity: 0.35,
      drawing: false,
    };

    const notes = []; // { id, element }
    let activeTextInput = null;

    // ---- size canvas wrap so getBoundingClientRect maps cleanly to canvas px
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

    // ---- annotate master toggle
    const setAnnotate = (on) => {
      state.annotating = on;
      toolsEl.hidden = !on;
      annotateBtn.classList.toggle('is-active', on);
      annotateBtn.setAttribute('aria-pressed', String(on));
      wrap.classList.toggle('is-annotating', on);
      if (!on) {
        commitText();
      }
    };
    annotateBtn.addEventListener('click', () => setAnnotate(!state.annotating));

    // ---- tool selector
    const setTool = (newTool) => {
      if (newTool === state.tool) return;
      commitText();
      state.tool = newTool;
      wrap.dataset.tool = newTool;
      root.querySelectorAll('.cv-tool').forEach(b => {
        b.classList.toggle('is-active', b.dataset.tool === newTool);
      });
      opacityWrap.hidden = newTool !== 'highlight';
    };
    root.querySelectorAll('.cv-tool').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    // ---- color pick
    root.querySelectorAll('.cv-color').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.cv-color').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.color = btn.dataset.color;
        // If user picks a color while erasing, switch to brush
        if (state.tool === 'eraser') setTool('brush');
      });
    });

    // ---- opacity slider
    opacityInput.addEventListener('input', () => {
      const v = Number(opacityInput.value);
      state.opacity = v / 100;
      opacityValue.textContent = `${v}%`;
    });

    // ---- clear (canvas + notes)
    root.querySelector('[data-act="clear"]').addEventListener('click', () => {
      dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      while (notes.length) {
        notes.pop().element.remove();
      }
      commitText(true);
    });

    // ---- download (composite of image + draw + notes)
    root.querySelector('[data-act="download"]').addEventListener('click', () => {
      commitText();
      const out = document.createElement('canvas');
      out.width = imageCanvas.width;
      out.height = imageCanvas.height;
      const octx = out.getContext('2d');
      octx.drawImage(imageCanvas, 0, 0);
      octx.drawImage(drawCanvas, 0, 0);
      _compositeNotesTo(octx, out);
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

    // ---- coord mapping
    const getPos = (e) => {
      const rect = drawCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * drawCanvas.width;
      const y = ((e.clientY - rect.top) / rect.height) * drawCanvas.height;
      return { x, y };
    };

    // ---- drawing (brush, highlight, eraser)
    const start = (e) => {
      if (!state.annotating) return;

      // Single-click tools
      if (state.tool === 'text') {
        e.preventDefault();
        const { x, y } = getPos(e);
        openTextInput(x, y);
        return;
      }
      if (state.tool === 'note') {
        e.preventDefault();
        const { x, y } = getPos(e);
        spawnNote(x, y);
        return;
      }

      // Drag tools
      e.preventDefault();
      drawCanvas.setPointerCapture?.(e.pointerId);
      const { x, y } = getPos(e);
      state.drawing = true;

      if (state.tool === 'eraser') {
        dctx.globalCompositeOperation = 'destination-out';
        dctx.globalAlpha = 1;
        dctx.strokeStyle = '#000';
        dctx.lineWidth = Math.max(18, drawCanvas.width / 80);
      } else if (state.tool === 'highlight') {
        dctx.globalCompositeOperation = 'source-over';
        dctx.globalAlpha = state.opacity;
        dctx.strokeStyle = state.color;
        dctx.lineWidth = Math.max(14, drawCanvas.width / 60);
      } else { // brush
        dctx.globalCompositeOperation = 'source-over';
        dctx.globalAlpha = 1;
        dctx.strokeStyle = state.color;
        dctx.lineWidth = Math.max(3, drawCanvas.width / 480);
      }

      dctx.beginPath();
      dctx.moveTo(x, y);
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
      dctx.globalAlpha = 1;
      try { drawCanvas.releasePointerCapture?.(e.pointerId); } catch {}
    };

    drawCanvas.addEventListener('pointerdown', start);
    drawCanvas.addEventListener('pointermove', move);
    drawCanvas.addEventListener('pointerup', end);
    drawCanvas.addEventListener('pointercancel', end);

    // ---- text tool: inline editable input → commit to canvas
    function openTextInput(x, y) {
      commitText();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cv-text-input';
      input.placeholder = 'Type…';

      const xPct = (x / drawCanvas.width) * 100;
      const yPct = (y / drawCanvas.height) * 100;
      input.style.left = `${xPct}%`;
      input.style.top  = `${yPct}%`;
      input.style.color = state.color;

      // Match on-canvas font size to what the input visually shows.
      const inputFontPx = Math.max(14, wrap.clientWidth / 38);
      input.style.fontSize = `${inputFontPx}px`;

      wrap.appendChild(input);
      // Defer focus so the click that spawned us doesn't immediately blur it.
      requestAnimationFrame(() => input.focus());

      activeTextInput = { input, x, y, color: state.color, fontPx: inputFontPx };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        if (e.key === 'Escape') {
          e.preventDefault();
          input.remove();
          if (activeTextInput && activeTextInput.input === input) activeTextInput = null;
        }
      });
      input.addEventListener('blur', () => {
        // Guard: only commit if this input is still the active one.
        const captured = input;
        setTimeout(() => {
          if (activeTextInput && activeTextInput.input === captured) commitText();
        }, 60);
      });
    }

    function commitText(silent = false) {
      if (!activeTextInput) return;
      const { input, x, y, color, fontPx } = activeTextInput;
      const value = input.value.trim();
      if (value && !silent) {
        // Compute on-canvas font size that matches the displayed input.
        const canvasFontPx = (fontPx / wrap.clientWidth) * drawCanvas.width;
        dctx.globalCompositeOperation = 'source-over';
        dctx.globalAlpha = 1;
        dctx.fillStyle = color;
        dctx.font = `700 ${canvasFontPx}px Inter, system-ui, sans-serif`;
        dctx.textBaseline = 'top';
        dctx.fillText(value, x, y);
      }
      input.remove();
      activeTextInput = null;
    }

    // ---- sticky notes
    function spawnNote(cx, cy) {
      const id = `note-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const el = document.createElement('div');
      el.className = 'cv-note';
      el.dataset.id = id;

      const xPct = (cx / drawCanvas.width) * 100;
      const yPct = (cy / drawCanvas.height) * 100;
      el.style.left = `${Math.max(0, Math.min(95, xPct))}%`;
      el.style.top  = `${Math.max(0, Math.min(90, yPct))}%`;

      el.innerHTML = `
        <button class="cv-note__close" type="button" aria-label="Delete note">${ICON.closeSm}</button>
        <textarea class="cv-note__text" rows="3" placeholder="Note…" aria-label="Note text"></textarea>
      `;

      el.querySelector('.cv-note__close').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = notes.findIndex(n => n.id === id);
        if (idx > -1) notes.splice(idx, 1);
        el.remove();
      });

      // Drag with pointer events (skip when hitting textarea or close button)
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('textarea, .cv-note__close')) return;
        e.preventDefault();
        const wrapRect = wrap.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = parseFloat(el.style.left);
        const startTop  = parseFloat(el.style.top);
        el.classList.add('is-dragging');

        const onMove = (ev) => {
          const dx = ((ev.clientX - startX) / wrapRect.width) * 100;
          const dy = ((ev.clientY - startY) / wrapRect.height) * 100;
          el.style.left = `${Math.max(0, Math.min(95, startLeft + dx))}%`;
          el.style.top  = `${Math.max(0, Math.min(95, startTop + dy))}%`;
        };
        const onUp = () => {
          el.classList.remove('is-dragging');
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });

      notesLayer.appendChild(el);
      notes.push({ id, element: el });
      requestAnimationFrame(() => el.querySelector('textarea').focus());
    }

    // ---- composite notes onto an output canvas (used by download)
    function _compositeNotesTo(octx, out) {
      if (!notes.length) return;
      const wrapRect = wrap.getBoundingClientRect();
      const sx = out.width / wrapRect.width;
      const sy = out.height / wrapRect.height;

      octx.save();
      for (const { element } of notes) {
        const r = element.getBoundingClientRect();
        const x = (r.left - wrapRect.left) * sx;
        const y = (r.top  - wrapRect.top ) * sy;
        const w = r.width  * sx;
        const h = r.height * sy;

        // Drop shadow
        octx.fillStyle = 'rgba(0,0,0,0.32)';
        octx.fillRect(x + 6 * sx, y + 8 * sy, w, h);

        // Note background
        const grad = octx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, '#fef3c7');
        grad.addColorStop(1, '#fde68a');
        octx.fillStyle = grad;
        octx.fillRect(x, y, w, h);

        // Border
        octx.strokeStyle = 'rgba(0,0,0,0.15)';
        octx.lineWidth = Math.max(1, sx);
        octx.strokeRect(x, y, w, h);

        // Text — wrap by words
        const ta = element.querySelector('textarea');
        const text = (ta?.value || '').trim();
        if (text) {
          const padding = 12 * sx;
          const fontPx = 14 * sx;
          const lineHeight = fontPx * 1.45;
          const maxWidth = w - padding * 2;

          octx.fillStyle = '#1a1300';
          octx.font = `500 ${fontPx}px Inter, system-ui, sans-serif`;
          octx.textBaseline = 'top';

          let yy = y + 28 * sy; // skip past close-button area
          for (const paragraph of text.split('\n')) {
            const words = paragraph.split(/\s+/);
            let line = '';
            for (const word of words) {
              const test = line ? `${line} ${word}` : word;
              if (octx.measureText(test).width > maxWidth && line) {
                octx.fillText(line, x + padding, yy);
                line = word;
                yy += lineHeight;
              } else {
                line = test;
              }
              if (yy > y + h - lineHeight) break;
            }
            if (line && yy < y + h - padding) {
              octx.fillText(line, x + padding, yy);
              yy += lineHeight;
            }
            if (yy > y + h - lineHeight) break;
          }
        }
      }
      octx.restore();
    }

    // ---- ESC closes viewer (but not while editing inside an input/textarea)
    const keyHandler = (e) => {
      if (e.key !== 'Escape') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      this.close();
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
