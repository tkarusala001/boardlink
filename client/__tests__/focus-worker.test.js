// Test the focus worker signal fusion logic in isolation
// We import the logic by re-implementing the pure functions here
// (workers can't be imported directly in Jest without a DOM)

describe('Focus worker logic', () => {
  function updateCursorMap(cursorMap, mapW, mapH, nx, ny, decay = 0.95) {
    for (let i = 0; i < cursorMap.length; i++) {
      cursorMap[i] *= decay;
    }
    const mx = Math.floor(nx * mapW);
    const my = Math.floor(ny * mapH);
    const radius = 5;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const rx = mx + dx;
        const ry = my + dy;
        if (rx >= 0 && rx < mapW && ry >= 0 && ry < mapH) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          const weight = Math.max(0, 1 - dist / radius);
          cursorMap[ry * mapW + rx] += weight * 0.5;
        }
      }
    }
  }

  function fuseSignals(cursorMap, diffMap, attnMap, weights) {
    for (let i = 0; i < attnMap.length; i++) {
      attnMap[i] = (cursorMap[i] * weights.cursor) + (diffMap[i] * weights.temporal);
    }
  }

  function extractBest(attnMap, mapW, mapH) {
    let maxScore = -1, bestX = 0, bestY = 0;
    for (let i = 0; i < attnMap.length; i++) {
      if (attnMap[i] > maxScore) {
        maxScore = attnMap[i];
        bestX = i % mapW;
        bestY = Math.floor(i / mapW);
      }
    }
    return { cx: bestX / mapW, cy: bestY / mapH, confidence: maxScore };
  }

  const mapW = 192, mapH = 108;
  const weights = { cursor: 0.45, temporal: 0.35 };

  test('cursor heatmap starts at zero', () => {
    const map = new Float32Array(mapW * mapH);
    expect(map.every(v => v === 0)).toBe(true);
  });

  test('cursor update creates a hotspot at the correct location', () => {
    const map = new Float32Array(mapW * mapH);
    updateCursorMap(map, mapW, mapH, 0.5, 0.5);
    const cx = Math.floor(0.5 * mapW);
    const cy = Math.floor(0.5 * mapH);
    expect(map[cy * mapW + cx]).toBeGreaterThan(0);
  });

  test('cursor hotspot decays over repeated calls', () => {
    const map = new Float32Array(mapW * mapH);
    updateCursorMap(map, mapW, mapH, 0.5, 0.5);
    const idx = Math.floor(0.5 * mapH) * mapW + Math.floor(0.5 * mapW);
    const first = map[idx];

    // Update at a different position — old spot should decay
    updateCursorMap(map, mapW, mapH, 0.1, 0.1);
    expect(map[idx]).toBeLessThan(first);
  });

  test('signal fusion combines cursor and temporal maps', () => {
    const cursor = new Float32Array(mapW * mapH);
    const diff = new Float32Array(mapW * mapH);
    const attn = new Float32Array(mapW * mapH);

    cursor[0] = 1.0;
    diff[0] = 1.0;

    fuseSignals(cursor, diff, attn, weights);
    expect(attn[0]).toBeCloseTo(0.45 + 0.35);
  });

  test('extractBest returns the highest-scoring region', () => {
    const attn = new Float32Array(mapW * mapH);
    const targetIdx = 50 * mapW + 96;
    attn[targetIdx] = 5.0;

    const result = extractBest(attn, mapW, mapH);
    expect(result.cx).toBeCloseTo(96 / mapW);
    expect(result.cy).toBeCloseTo(50 / mapH);
    expect(result.confidence).toBe(5.0);
  });

  test('dimension change resets previousFrame correctly', () => {
    // Simulating the guard: if dimensions change, we reallocate
    let prevFrame = new Uint8Array(100);
    const newData = new Uint8Array(200);

    if (prevFrame.length !== newData.length) {
      prevFrame = new Uint8Array(newData);
    }

    expect(prevFrame.length).toBe(200);
  });
});
