// Focus Worker — fuses cursor + temporal signals to find the active region

let width = 0;
let height = 0;
let previousFrame = null;
let cursorMap = null;
let diffMap = null;
let attnMap = null;

const weights = {
  cursor: 0.45,
  temporal: 0.35,
  density: 0.20
};

const decayPerFrame = 0.95; // Rolling heatmap decay

self.onmessage = (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'INIT':
      width = payload.width;
      height = payload.height;
      
      // Initialize heatmaps at 1/10th scale for performance
      const mapSize = (width / 10) * (height / 10);
      cursorMap = new Float32Array(mapSize);
      diffMap = new Float32Array(mapSize);
      attnMap = new Float32Array(mapSize);
      break;

    case 'PROCESS_CURSOR':
      const { x, y } = payload;
      updateCursorHeatmap(x, y);
      break;

    case 'PROCESS_FRAME':
      const { imageData } = payload;
      updateTemporalMap(imageData);
      fuseSignals();
      const bestRegion = extractBestRegion();
      self.postMessage({ type: 'FOCUS_RESULT', payload: bestRegion });
      break;
  }
};

function updateCursorHeatmap(nx, ny) {
  if (!cursorMap) return;
  const mapW = width / 10;
  const mapH = height / 10;
  const mx = Math.floor(nx * mapW);
  const my = Math.floor(ny * mapH);
  
  // Decaying existing heatmap
  for (let i = 0; i < cursorMap.length; i++) {
    cursorMap[i] *= decayPerFrame;
  }
  
  // Add a Gaussian pulse at cursor location
  const radius = 5;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const rx = mx + dx;
      const ry = my + dy;
      if (rx >= 0 && rx < mapW && ry >= 0 && ry < mapH) {
        const dist = Math.sqrt(dx*dx + dy*dy);
        const weight = Math.max(0, 1 - dist / radius);
        cursorMap[ry * mapW + rx] += weight * 0.5;
      }
    }
  }
}

function updateTemporalMap(imageData) {
  if (!previousFrame || previousFrame.length !== imageData.data.length) {
    previousFrame = new Uint8Array(imageData.data);
    return;
  }

  const mapW = width / 10;
  const mapH = height / 10;
  const data = imageData.data;
  
  // Pixel-wise difference at 1/10th resolution
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const originalIdx = (y * 10 * width + x * 10) * 4;
      const r = data[originalIdx], g = data[originalIdx+1], b = data[originalIdx+2];
      const pr = previousFrame[originalIdx], pg = previousFrame[originalIdx+1], pb = previousFrame[originalIdx+2];
      
      const diff = (Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb)) / 3;
      diffMap[y * mapW + x] = diff > 15 ? (diff / 255) : 0;
    }
  }

  previousFrame.set(data);
}

function fuseSignals() {
  for (let i = 0; i < attnMap.length; i++) {
    attnMap[i] = (cursorMap[i] * weights.cursor) + (diffMap[i] * weights.temporal);
    // (Stroke density omitted for initial pass)
  }
}

function extractBestRegion() {
  const mapW = width / 10;
  const mapH = height / 10;
  let maxScore = -1;
  let bestX = 0, bestY = 0;

  for (let i = 0; i < attnMap.length; i++) {
    if (attnMap[i] > maxScore) {
      maxScore = attnMap[i];
      bestX = i % mapW;
      bestY = Math.floor(i / mapW);
    }
  }

  // Convert back to 0-1 range
  return {
    cx: bestX / mapW,
    cy: bestY / mapH,
    confidence: maxScore,
    // Suggested bounding box (2x expansion)
    width: 0.5, 
    height: 0.35
  };
}
