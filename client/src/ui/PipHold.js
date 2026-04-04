export default class PipHold {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.holds = [];
    this.maxHolds = 3; // REQ-029
  }

  capture() {
    if (this.holds.length >= this.maxHolds) {
      alert('Maximum 3 captures allowed. Please close one first.');
      return;
    }

    const holdId = Date.now();
    const pipEl = document.createElement('div');
    pipEl.className = 'pip-hold card';
    pipEl.id = `pip-${holdId}`;
    
    // Captured Frame
    const frame = document.createElement('canvas');
    frame.width = this.canvas.width;
    frame.height = this.canvas.height;
    const fctx = frame.getContext('2d');
    fctx.drawImage(this.canvas, 0, 0);

    // Metadata
    const timeLabel = document.createElement('div');
    timeLabel.innerText = `Captured at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    timeLabel.style.fontSize = '0.7rem';
    timeLabel.style.color = 'var(--text-muted)';
    timeLabel.style.marginTop = '0.5rem';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.innerText = '✕';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '0';
    closeBtn.style.right = '0';
    closeBtn.style.padding = '0.2rem 0.5rem';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = 'var(--error)';
    closeBtn.style.fontSize = '1.2rem';
    closeBtn.onclick = () => this.remove(holdId);

    // UI Assembly
    pipEl.style.position = 'absolute';
    pipEl.style.width = '300px';
    pipEl.style.zIndex = '50';
    pipEl.style.cursor = 'move';
    pipEl.style.padding = '1rem';
    pipEl.style.bottom = '1rem';
    pipEl.style.right = '1rem';
    pipEl.style.background = 'var(--bg-tertiary)';

    pipEl.appendChild(closeBtn);
    pipEl.appendChild(frame);
    pipEl.appendChild(timeLabel);
    
    this.container.appendChild(pipEl);
    this.makeDraggable(pipEl);
    this.holds.push({ id: holdId, element: pipEl });
  }

  makeDraggable(el) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    el.onmousedown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (e) => {
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        el.style.top = (el.offsetTop - pos2) + "px";
        el.style.left = (el.offsetLeft - pos1) + "px";
        el.style.bottom = 'auto'; // Release fixed bottom
        el.style.right = 'auto';
      };
    };
  }

  remove(id) {
    const index = this.holds.findIndex(h => h.id === id);
    if (index > -1) {
      this.holds[index].element.remove();
      this.holds.splice(index, 1);
    }
  }
}
