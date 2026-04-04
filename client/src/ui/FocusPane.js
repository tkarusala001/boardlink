export default class FocusPane {
  constructor(videoSource, canvasFocus, canvasThumb, thumbHighlight) {
    this.videoSource = videoSource;
    this.canvasFocus = canvasFocus;
    this.canvasThumb = canvasThumb;
    this.thumbHighlight = thumbHighlight;

    // Spring State (REQ-001/Section 9.2)
    this.x = 0.5; this.y = 0.5;
    this.vX = 0; this.vY = 0;
    this.targetX = 0.5; this.targetY = 0.5;

    this.stiffness = 120;
    this.damping = 14;
    this.zoom = 2.0;

    this.isAuto = true;
    this.confidenceIndicator = document.getElementById('focus-confidence');

    this.animate();
  }

  setTarget(nx, ny, confidence) {
    if (!this.isAuto) return;
    this.targetX = nx;
    this.targetY = ny;
    this.updateConfidenceUI(confidence);
  }

  updateConfidenceUI(confidence) {
    if (!this.confidenceIndicator) return;
    const border = confidence > 0.6 ? 'rgba(0, 255, 0, 0.4)' : (confidence > 0.3 ? 'rgba(255, 165, 0, 0.4)' : 'rgba(255, 0, 0, 0.4)');
    this.confidenceIndicator.style.borderColor = border;
  }

  animate() {
    const dt = 1/60;
    const fX = -this.stiffness * (this.x - this.targetX) - this.damping * this.vX;
    const fY = -this.stiffness * (this.y - this.targetY) - this.damping * this.vY;
    
    this.vX += fX * dt;
    this.vY += fY * dt;
    this.x += this.vX * dt;
    this.y += this.vY * dt;

    this.x = Math.max(0, Math.min(1, this.x));
    this.y = Math.max(0, Math.min(1, this.y));

    if (this.videoSource.readyState === this.videoSource.HAVE_ENOUGH_DATA) {
      this.renderFocus();
      this.renderThumbnail();
    }

    requestAnimationFrame(() => this.animate());
  }

  renderFocus() {
    const ctx = this.canvasFocus.getContext('2d');
    const w = this.videoSource.videoWidth;
    const h = this.videoSource.videoHeight;
    
    const zoomW = w / this.zoom;
    const zoomH = h / this.zoom;
    
    let sx = (this.x * w) - (zoomW / 2);
    let sy = (this.y * h) - (zoomH / 2);
    
    sx = Math.max(0, Math.min(w - zoomW, sx));
    sy = Math.max(0, Math.min(h - zoomH, sy));

    ctx.clearRect(0, 0, this.canvasFocus.width, this.canvasFocus.height);
    ctx.drawImage(this.videoSource, sx, sy, zoomW, zoomH, 0, 0, this.canvasFocus.width, this.canvasFocus.height);
  }

  renderThumbnail() {
    const ctx = this.canvasThumb.getContext('2d');
    ctx.clearRect(0, 0, this.canvasThumb.width, this.canvasThumb.height);
    ctx.drawImage(this.videoSource, 0, 0, this.canvasThumb.width, this.canvasThumb.height);

    const thumbW = this.canvasThumb.width;
    const thumbH = this.canvasThumb.height;
    const highlightW = thumbW / this.zoom;
    const highlightH = thumbH / this.zoom;

    this.thumbHighlight.style.width = `${highlightW}px`;
    this.thumbHighlight.style.height = `${highlightH}px`;
    this.thumbHighlight.style.left = `${(this.x * thumbW) - (highlightW / 2)}px`;
    this.thumbHighlight.style.top = `${(this.y * thumbH) - (highlightH / 2)}px`;
  }

  toggleAuto(val) {
    this.isAuto = val;
  }
}
