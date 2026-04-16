import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Proxy app-level WebSocket connections to the local signaling server.
      '/': {
        target: 'ws://localhost:8082',
        ws: true,
        bypass(req) {
          // Pass regular HTTP through to Vite (assets, index.html, etc.)
          if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
            return req.url;
          }

          // Vite's own HMR client connects with Sec-WebSocket-Protocol: vite-hmr.
          // If we forward those to the signaling server the ws library receives
          // Vite's binary HMR frames and throws WS_ERR_INVALID_CLOSE_CODE on
          // every HMR message, spamming the console and killing HMR.
          // Returning req.url here tells Vite to handle the connection itself.
          const proto = req.headers['sec-websocket-protocol'] || '';
          if (proto.includes('vite-hmr')) {
            return req.url;
          }

          // All other WebSocket upgrades → signaling server.
        },
      },
    },
  },
});
