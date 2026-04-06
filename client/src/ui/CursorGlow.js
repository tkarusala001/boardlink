export default class CursorGlow {
  constructor(container) {
    this.container = container;
    this.element = document.createElement('div');
    this.element.id = 'cursor-glow';
    this.setupStyles();
    this.container.appendChild(this.element);

    this.x = 0;
    this.y = 0;
    this.targetX = 0;
    this.targetY = 0;
    
    this.settings = {
      size: 48, // Medium
      color: '#ffcc00',
      opacity: 0.7
    };

    this.animate();
  }

  setupStyles() {
    Object.assign(this.element.style, {
      position: 'absolute',
      pointerEvents: 'none',
      borderRadius: '50%',
      zIndex: '100',
      transform: 'translate(-50%, -50%)',
      boxShadow: '0 0 15px rgba(255, 255, 255, 0.5)',
      border: '3px solid white',
      transition: 'opacity 0.2s',
      display: 'none'
    });
  }

  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.applySettings();
  }

  applySettings() {
    this.element.style.width = `${this.settings.size}px`;
    this.element.style.height = `${this.settings.size}px`;
    this.element.style.backgroundColor = this.settings.color;
    this.element.style.opacity = this.settings.opacity;
  }

  moveTo(nx, ny) {
    this.element.style.display = 'block';
    // Normalized coordinates (0-1) to pixel coordinates
    const rect = this.container.getBoundingClientRect();
    this.targetX = nx * rect.width;
    this.targetY = ny * rect.height;
  }

  animate() {
    // Lerp for smooth motion
    this.x += (this.targetX - this.x) * 0.2;
    this.y += (this.targetY - this.y) * 0.2;

    this.element.style.left = `${this.x}px`;
    this.element.style.top = `${this.y}px`;

    const time = Date.now() / 600;
    const scale = 0.85 + Math.sin(time) * 0.15;
    this.element.style.transform = `translate(-50%, -50%) scale(${scale})`;

    requestAnimationFrame(() => this.animate());
  }

  hide() {
    this.element.style.display = 'none';
  }
}
