// focus worker - cursor + temporal heatmap

let width = 0;
let height = 0;
let previousFrame = null;
let cursorMap = null;
let diffMap = null;
let attnMap = null;

// cursor matters most bc it's intentional, motion second, density least
const weights = {
  cursor: 0.45,
  temporal: 0.35,
  density: 0.20
};

// each frame old heat fades -- so if teacher stops moving the zoom doesnt stay stuck
const decayPerFrame = 0.95;

self.onmessage = (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'INIT':
      width = payload.width;
      height = payload.height;

      // 1/10th scale -- full 1080p would be 2M pixel ops per frame, this is 20k
      // Math.floor is not optional -- 1366/10 = 136.6 and float array indices
      // silently corrupt the whole heatmap, took a while to track that bug down
      const mapSize = Math.floor(width / 10) * Math.floor(height / 10);
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
  const mapW = Math.floor(width / 10);
  const mapH = Math.floor(height / 10);
  const mx = Math.floor(nx * mapW);
  const my = Math.floor(ny * mapH);
  
  for (let i = 0; i < cursorMap.length; i++) {
    cursorMap[i] *= decayPerFrame;
  }

  // spread heat outward from cursor -- closer pixels get more weight, falls off linearly
  // if you just marked the exact cursor pixel the focus would jitter constantly
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

  const mapW = Math.floor(width / 10);
  const mapH = Math.floor(height / 10);
  const data = imageData.data;
  
  // Pixel-wise difference at 1/10th resolution
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const originalIdx = (y * 10 * width + x * 10) * 4;
      const r = data[originalIdx], g = data[originalIdx+1], b = data[originalIdx+2];
      const pr = previousFrame[originalIdx], pg = previousFrame[originalIdx+1], pb = previousFrame[originalIdx+2];
      
      const diff = (Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb)) / 3;
      // threshold at 15 filters out h264 compression noise -- below that its just codec artifacts not real motion
      diffMap[y * mapW + x] = diff > 15 ? (diff / 255) : 0;
    }
  }

  previousFrame.set(data);
}

function fuseSignals() {
  for (let i = 0; i < attnMap.length; i++) {
    attnMap[i] = (cursorMap[i] * weights.cursor) + (diffMap[i] * weights.temporal);
  }
}

function extractBestRegion() {
  const mapW = Math.floor(width / 10);
  const mapH = Math.floor(height / 10);
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
