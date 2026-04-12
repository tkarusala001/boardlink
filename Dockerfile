# ---- Build stage ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Build the client SPA
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# Install server production dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy the server source
COPY server/*.js ./server/

# ---- Run stage -----------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# Copy server + built client from the builder stage
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist

WORKDIR /app/server

# Expose the port used by the HTTP + WebSocket server
EXPOSE 8082

# Start the server
CMD ["node", "index.js"]
