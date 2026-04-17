# BoardLink Complete End-to-End Architecture Guide

Last updated: 2026-04-16

This document is a deep technical explanation of how BoardLink works end to end, including runtime flow, module interactions, protocol behavior, reliability mechanisms, deployment, testing, and important caveats.

## 1) What BoardLink Is

BoardLink is an accessibility-first classroom screen sharing app.

- Teacher starts a room and shares their screen.
- Students join with a 4-character room code.
- Signaling is handled by a Node.js WebSocket server.
- Media flows browser-to-browser over WebRTC (teacher to each student).
- Student-side enhancements run in the browser (palette transforms, focus assist, captures, annotation, cursor glow).

The architecture separates:

- Control plane: signaling over WebSocket.
- Media plane: WebRTC peer connections.
- UX/render plane: client-side canvas + workers + UI components.

## 2) High-Level System Architecture

## Frontend (client)

- Entry: client/src/main.js
- Signaling client: client/src/signaling.js
- WebRTC client: client/src/webrtc.js
- UI modules:
  - client/src/ui/CursorGlow.js
  - client/src/ui/FocusPane.js
  - client/src/ui/CaptureGallery.js
  - client/src/ui/PipHold.js (legacy, currently not used by main flow)
- Workers:
  - client/src/workers/focus-worker.js (active)
  - client/src/workers/processing-worker.js (present, currently not wired in main flow)

## Backend (server)

- Entry + factory: server/index.js
- Responsibilities:
  - Room lifecycle
  - Join/rejoin orchestration
  - Message validation and routing
  - Rate limiting for failed joins
  - Room and cache GC
  - Health endpoint
  - Optional static serving of built client assets

## Build/deploy

- Dev: root package scripts run server + Vite client in parallel.
- Production: Docker builds client and runs server; server can serve client/dist.
- Fly.io config included.
- Vercel configs included for client-only deployments.

## 3) Runtime Lifecycle End to End

## Phase A: App load and view model bootstrap

1. index.html loads the SPA shell and main module script.
2. main.js captures all key DOM nodes and initializes app-level state.
3. Landing page offers two paths:
   - Teacher start
   - Student join

The app uses explicit view switching with showView(viewName), hiding other panels and revealing the active one.

## Phase B: Signaling setup

Whenever teacher or student needs network actions, initSignaling() ensures a single SignalingClient instance.

Signaling URL resolution priority:

1. VITE_WS_URL if provided.
2. If on *.vercel.app, fallback to wss://boardlink.fly.dev.
3. Else same-origin WS URL based on current protocol and host.

This is designed so:

- Local dev works with same-origin proxy behavior.
- Unified single-origin deployments work naturally.
- Split deployments can still work via explicit VITE_WS_URL.

## Phase C: Teacher room creation

Teacher click path:

1. User presses Start as Teacher.
2. Client connects signaling and sends CREATE_ROOM.
3. Server generates a 4-char room code (safe alphabet without 0/1 ambiguity).
4. Server creates room state with teacher ws, student map, timestamps.
5. Server responds ROOM_CREATED.
6. Client switches to teacher view and starts teacher WebRTC session.

Teacher WebRTC setup:

- getDisplayMedia() captures screen (video only).
- Stream stored on WebRTCClient instance.
- If students were queued before stream readiness, connections are created after stream capture succeeds.

Teacher diagnostics:

- Optional monitor panel shows stream resolution/fps and per-student connection/ICE state.

## Phase D: Student join

Student click path:

1. Student enters 4-char code and presses Connect.
2. Client sends JOIN_ROOM.
3. Server validates:
   - room code format
   - room existence
   - failed-attempt rate limit bucket by IP
4. On success, server:
   - creates unique peerId in room
   - creates a sessionId for grace rejoin
   - returns JOIN_SUCCESS with roomCode, peerId, sessionId
5. Teacher gets STUDENT_JOINED event and student count.
6. Teacher creates a dedicated RTCPeerConnection for that peer and sends OFFER.

## Phase E: WebRTC offer/answer/ICE exchange

Teacher side per student:

- Creates RTCPeerConnection.
- Adds all teacher stream tracks.
- Creates data channel "cursorUpdates".
- Creates offer and sets local description.
- Sends OFFER with targetPeerId.

Student side:

- Receives OFFER.
- Sets remote description.
- Drains queued ICE candidates if any.
- Creates answer and sets local description.
- Sends ANSWER.

Teacher then:

- Receives ANSWER.
- Sets remote description for that student peer.
- Drains any queued ICE candidates.

ICE behavior:

- Both sides emit ICE candidates as gathered.
- If remote description is not ready yet, candidates are queued.
- Once ready, queued candidates are applied.

This queueing reduces negotiation race failures.

## Phase F: Live stream rendering and student UX pipeline

When student receives track:

1. ontrack receives stream.
2. hidden video element is attached and played (acts as frame source).
3. requestAnimationFrame loop draws video frames onto main canvas.
4. palette class is applied to canvas depending on selected palette.

In parallel:

- Teacher cursor normalized positions arrive on data channel.
- CursorGlow animates an overlay marker.
- Focus worker receives cursor events and sampled frame data.
- FocusPane receives worker outputs and renders a zoomed auto-focus area.

Focus worker pipeline:

- Maintains low-resolution maps for performance.
- Cursor heatmap with decay models recent pointer attention.
- Temporal diff map models motion regions.
- Weighted fusion computes attention map.
- Best region is emitted with confidence.

FocusPane pipeline:

- Uses spring dynamics for smooth target movement.
- Crops source video with zoom into focus canvas.
- Updates thumbnail + highlight rectangle for context.
- Supports auto/manual control handoff.

## Phase G: Freeze-frame capture and annotation

CaptureGallery supports:

- Snapshot from current main canvas.
- Right sidebar listing captures with metadata.
- Fullscreen viewer.
- Annotation tools:
  - brush
  - highlighter (opacity control)
  - text input
  - sticky notes
  - eraser
- Composite export to downloadable PNG.

Keyboard support:

- Space captures a frame.

## Phase H: Disconnects, reconnect, and session continuity

Client signaling resilience:

- Queues messages while disconnected.
- Exponential backoff reconnect attempts.
- Restores connection and drains queue.

Student grace rejoin model:

- sessionId and roomCode are stored in sessionStorage.
- On reconnect, client attempts REJOIN_ROOM.
- Server maps sessionId to previous peerId for identity continuity.
- On success, server issues a new sessionId and notifies teacher with STUDENT_REJOINED.

Grace expiration:

- If disconnected student does not return within 30 seconds, grace session is removed.

Teacher disconnect behavior:

- Server notifies all students session ended.
- Room and related grace sessions are cleaned up.

## 4) Signaling Protocol Model

All messages use envelope shape:

```json
{
  "v": 1,
  "type": "MESSAGE_TYPE",
  "roomCode": "AB23",
  "payload": {}
}
```

Common message types:

- CREATE_ROOM
- ROOM_CREATED
- JOIN_ROOM
- JOIN_SUCCESS
- REJOIN_ROOM
- REJOIN_SUCCESS
- STUDENT_JOINED
- STUDENT_LEFT
- STUDENT_REJOINED
- OFFER
- ANSWER
- ICE_CANDIDATE
- ERROR
- SYS_OBSOLETE_CLIENT

Targeted routing:

- OFFER and teacher ICE use targetPeerId.
- Student ANSWER and student ICE route back to room teacher with source peerId.

## 5) Server State Model and Lifecycle

Primary maps in server/index.js:

- rooms: roomCode -> { teacher, students, lastActivity, createdAt }
- rateLimitCache: ip -> { count, resetTime }
- graceSessions: sessionId -> { roomCode, peerId, timer }

Room lifecycle controls:

- Absolute room TTL: 30 minutes.
- Periodic GC sweep: every 60 seconds.
- Conditions checked include abandoned, stale, expired.

Operational endpoint:

- GET /health returns status, room count, uptime.

Static serving mode:

- If client/dist exists and sirv is available, server serves SPA.
- Else server responds with text indicating signaling-only mode.

## 6) Accessibility and UX Features

Implemented features:

- Live screen-reader announcement region for key events.
- Palette modes for different visual needs.
- Focus pane with confidence cues.
- Cursor glow tracking.
- Freeze and annotation for review.
- Keyboard capture shortcut.

Design system highlights:

- High contrast dark-forward theme.
- Explicit focus-visible styles.
- Motion and visual depth while keeping controls legible.

## 7) Security and Hardening

Current safeguards:

- Zod validation for incoming signaling envelopes.
- Protocol version guard (obsolete client rejection).
- Room code format enforcement.
- Failed join rate limiting by IP window.
- WS max payload cap + compression settings.
- Permission-policy headers in Vercel config (client hosting).

## 8) Testing Coverage Snapshot

Server tests cover:

- Validation schema behavior.
- Room management logic.
- Integration scenarios (health, create, join, rejoin, teacher disconnect, rate limit).

Client tests cover:

- Signaling queue/reconnect message behavior (logic-level).
- WebRTC state/flow behavior via mocks.
- Focus worker signal fusion logic.

Note: most tests are unit and simulated integration; no full real-browser E2E suite for classroom behavior yet.

## 9) Deployment Topologies

## Recommended: single origin

- Deploy server with built client assets.
- Browser gets SPA and signaling from same host.
- Simplifies WebSocket URL and avoids CORS/mixed-origin confusion.

## Split frontend/backend

- Host client on Vercel.
- Host signaling server elsewhere (for example Fly).
- Set VITE_WS_URL at build time.

## Local development

- Root dev script runs server and Vite in parallel.
- Vite proxy forwards app WS traffic to localhost:8082.
- Vite HMR websocket is intentionally bypassed from proxy forwarding.

## 10) Important Caveats and Drift (Extra Critical Notes)

These are especially important when operating or extending the app.

1. README behavior drift exists in places.
   - Example: shortcut docs mention Shift+F cycle filters, but current main.js key handler implements Space capture only.

2. processing-worker.js is currently present but not wired in the active main render loop.
   - So bold-ink processing is not currently active in the main runtime path.

3. PipHold.js exists but main capture experience uses CaptureGallery.
   - PipHold appears legacy/non-active in current app wiring.

4. Potential stale-room GC risk in active sessions.
   - Room stale check uses lastActivity and 60s threshold.
   - lastActivity is updated on signaling events, not on continuous media/data flow.
   - Long quiet sessions with no signaling events could be treated as stale by GC even while WebRTC media is live.

5. Documentation vs implementation details may differ over time.
   - Example areas: rate-limit threshold, keyboard shortcuts, processing pipeline status.

6. getDisplayMedia requirements still apply.
   - Must be localhost or secure context (HTTPS) for teacher share to start.

## 11) Performance Characteristics

Strengths:

- Peer-to-peer media avoids server media relay cost.
- Worker offloading for focus analysis protects UI thread.
- Low-frequency frame sampling for focus reduces per-frame CPU cost.

Tradeoffs:

- Teacher uses mesh fan-out (one RTCPeerConnection per student).
- As class size grows, teacher CPU/network becomes bottleneck.
- No TURN default means some restrictive networks may fail P2P.

## 12) Recommended Next Improvements

High-priority technical improvements:

1. Add TURN support as first-class configuration for school networks.
2. Add browser E2E tests for join, stream start, reconnect, and capture workflows.
3. Wire processing-worker into active pipeline or remove dead path until ready.
4. Revisit stale-room GC criteria to avoid dropping active but signaling-idle sessions.
5. Add runtime telemetry:
   - peer connection states
   - reconnect counts
   - frame render FPS
   - worker latency

Product/documentation improvements:

1. Align README and in-app behavior (shortcuts and feature list).
2. Add operator runbook for teachers (pre-class checks and failure handling).
3. Add explicit deployment matrix guidance for same-origin vs split deployments.

## 13) Quick Debug Runbook

If stream does not appear for students:

1. Confirm signaling connected in browser console.
2. Confirm JOIN_SUCCESS and teacher STUDENT_JOINED events arrived.
3. Check OFFER/ANSWER/ICE flow logs on both sides.
4. Check peer connection and ICE states in teacher monitor.
5. Check if restrictive network might require TURN.

If reconnect fails:

1. Verify sessionStorage has bl_session_id and bl_room_code.
2. Verify REJOIN_ROOM sent after signaling reconnection.
3. Confirm grace session not expired (30s window).
4. Confirm room still exists on server.

If app loads but no UI in production:

1. Confirm client/dist exists in server runtime image.
2. Confirm static serving is enabled (sirv available).
3. Check /health endpoint and server logs.

## 14) One-Page Mental Model

Think of BoardLink as three synchronized loops:

1. Control loop (WebSocket signaling): create/join/rejoin + negotiation events.
2. Media loop (WebRTC): teacher video stream fan-out to students.
3. Attention loop (client UX): cursor + frame analysis -> focus guidance + student tools.

As long as all three loops remain healthy, the classroom experience is smooth.
When issues appear, isolate which loop failed first and debug in that order.
