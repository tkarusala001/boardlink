# ---- Build stage ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install only production dependencies
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copy the server source
COPY server/ ./

# ---- Run stage -----------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# Copy the built files from the builder stage
COPY --from=builder /app ./

# Expose the port used by the WebSocket server
EXPOSE 8082

# Start the server
CMD ["node", "index.js"]
