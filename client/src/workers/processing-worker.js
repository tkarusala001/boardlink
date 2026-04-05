// BoardLink Processing Worker
// Handles Bold-Ink (Sobel + Dilation) and Color Transformations

self.onmessage = (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'PROCESS_FRAME':
      processFrame(payload);
      break;
    case 'PROCESS_FRAME_BITMAP':
      processFrameBitmap(payload);
      break;
  }
};

let offscreenCanvas = null;
let offscreenCtx = null;

function processFrameBitmap({ bitmap, filterLevel, palette }) {
  if (!offscreenCanvas) {
    offscreenCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  } else if (offscreenCanvas.width !== bitmap.width || offscreenCanvas.height !== bitmap.height) {
    offscreenCanvas.width = bitmap.width;
    offscreenCanvas.height = bitmap.height;
  }

  offscreenCtx.drawImage(bitmap, 0, 0);
  const imageData = offscreenCtx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();

  if (filterLevel !== 'none') {
    const processedData = applyBoldInk(imageData, filterLevel);
    self.postMessage({ type: 'FRAME_PROCESSED', payload: { imageData: processedData } });
  } else {
    self.postMessage({ type: 'FRAME_PROCESSED', payload: { imageData } });
  }
}

function processFrame({ imageData, filterLevel, palette }) {
  if (filterLevel !== 'none') {
    const processedData = applyBoldInk(imageData, filterLevel);
    self.postMessage({ type: 'FRAME_PROCESSED', payload: { imageData: processedData } });
  } else {
    self.postMessage({ type: 'FRAME_PROCESSED', payload: { imageData } });
  }
}

function applyBoldInk(imageData, level) {
  const { width, height, data } = imageData;
  const radius = level === 'light' ? 1 : (level === 'medium' ? 2 : 3);
  const output = new Uint8ClampedArray(data);

  // Simple Box Dilation for performance (REQ-020)
  // We only dilate dark pixels on light backgrounds (REQ-021)
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const idx = (y * width + x) * 4;
      
      // REQ-021: Only process if stroke is dark (luminance < 80)
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b);

      if (lum < 80) {
        // Dilate: Spread this dark pixel to neighbors
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nIdx = ((y + dy) * width + (x + dx)) * 4;
            output[nIdx] = r;
            output[nIdx+1] = g;
            output[nIdx+2] = b;
            output[nIdx+3] = data[idx+3]; // Preserve alpha
          }
        }
      }
    }
  }

  return new ImageData(output, width, height);
}
