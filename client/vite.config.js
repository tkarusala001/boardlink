import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Proxy WebSocket connections to the local signaling server in dev
      '/': {
        target: 'ws://localhost:8082',
        ws: true,
        // Only proxy WebSocket upgrade requests, not regular HTTP
        bypass(req) {
          // Let regular HTTP requests through to Vite
          if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
            return req.url;
          }
          // WebSocket requests get proxied to the signaling server
        },
      },
    },
  },
});
