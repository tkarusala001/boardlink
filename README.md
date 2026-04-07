# BoardLink

BoardLink is an accessibility-first classroom screen sharing app designed for students with low vision.
It lets a teacher share their screen in real time while each student gets visual assist features such as bold-ink filtering, color palettes, cursor glow tracking, focus zoom, and freeze-frame capture.

This README is intentionally end-to-end and realistic. It documents not just the happy path, but also the problems, conflicts, failed attempts, and production hardening decisions that happened while building the app.

## 1. Problem Statement

In many classrooms, students with low vision still depend on physical seating position and board visibility. BoardLink aims to reduce that barrier with:

- Fast room-based join flow (4-character code)
- Real-time teacher screen stream to students
- Student-side accessibility controls without needing teacher intervention
- Resilient reconnect behavior when signaling drops temporarily

## 2. Current Feature Set

### Teacher

- Start a classroom session and generate a room code
- Share display using browser screen capture
- Broadcast stream to multiple students (1:N peer mesh)
- Send normalized cursor coordinates over data channels

### Student

- Join by room code
- Receive teacher stream in real time
- Use Bold-Ink filters: `none`, `light`, `medium`, `heavy`
- Switch color palettes: default, high-contrast dark/warm, cataracts, tritanopia, invert
- Freeze frames into draggable PiP cards (up to 3)
- Toggle Focus Pane with automatic focus tracking and manual override
- Keyboard shortcuts:
  - `Space`: capture freeze frame
  - `Shift+F`: cycle filter levels

### Reliability and Security

- Protocol version guard (`SYS_OBSOLETE_CLIENT`)
- 4KB WebSocket payload cap
- Zod validation for incoming signaling messages
- Room-code format enforcement (`^[2-9A-Z]{4}$`)
- IP-based failed join rate limiting (5 fails / 15 min)
- 30-second student grace session for reconnect
- Room and cache garbage collection sweep every 60 seconds

## 3. Architecture

### High-level flow

1. Teacher opens app and creates a room.
2. Server returns a 4-character room code.
3. Student joins with that code through signaling server.
4. Teacher creates a dedicated `RTCPeerConnection` for that student.
5. WebRTC media flows peer-to-peer.
6. Student browser applies optional processing in workers.

### Why this split

- Signaling server handles orchestration, validation, and session lifecycle.
- Browsers handle media transport directly for lower server load.
- Workers keep heavy image operations off the main UI thread.

## 4. Repository Layout

```text
boardlink/
  client/                     # Vite browser app
	 src/main.js               # app entry and UI wiring
	 src/signaling.js          # signaling client with reconnect queue
	 src/webrtc.js             # teacher/student WebRTC logic
	 src/ui/*                  # CursorGlow, FocusPane, PipHold
	 src/workers/*             # processing and focus workers
	 __tests__/focus-worker.test.js

  server/
	 index.js                  # ws signaling server + room lifecycle
	 __tests__/rooms.test.js
	 __tests__/validation.test.js
```

## 5. Local Setup (End-to-End)

### Prerequisites

- Node.js 18+
- npm 9+
- Modern Chromium-based browser (WebRTC + OffscreenCanvas + ImageBitmap support)

### Install

From repo root:

```bash
npm install
cd server && npm install
cd ../client && npm install
cd ..
```

### Run

```bash
npm run dev
```

This starts:

- WebSocket signaling server at `ws://localhost:8082`
- Vite client dev server (default Vite port)

### Manual E2E smoke test

1. Open one browser tab as Teacher.
2. Start share and get room code.
3. Open one or more student tabs.
4. Join with room code.
5. Validate stream, cursor glow, filters, palette switch, and freeze frame.
6. Close a student tab and reopen quickly to confirm grace-session rejoin behavior.

## 6. Automated Test Baseline

Executed locally on April 6, 2026.

### Server

```bash
cd server
npm test
```

Result:

- 2 test suites passed
- 21 tests passed

### Client

```bash
cd client
npm test
```

Result:

- 1 test suite passed
- 6 tests passed

## 7. End-to-End Build Story (What Actually Happened)

This section captures the implementation journey in phases, including friction points.

### Phase A: Baseline prototype

Successes:

- Basic teacher-to-student screen stream worked.
- Room creation and join path was functional.

Problems:

- Signaling trusted payloads too much.
- One malformed message could cause undefined behavior.
- No robust session lifecycle handling for disconnects.

Outcome:

- Moved from permissive signaling to schema-validated signaling.

### Phase B: Signaling hardening

Successes:

- Added Zod wrapper validation for all incoming message envelopes.
- Enforced room code format and payload limits.
- Added protocol version check to reject stale clients safely.

Problems:

- Early dev builds produced confusing mismatches between client and server payload shape during iterative changes.
- Invalid or old clients failed silently before explicit `SYS_OBSOLETE_CLIENT` handling.

Fixes:

- Standardized message wrapper (`v`, `type`, `roomCode`, `payload`).
- Added explicit obsolete client event handling in client signaling layer.

### Phase C: Single-peer to multi-peer teacher topology

Successes:

- Teacher now creates one `RTCPeerConnection` per student.
- Added targeted offer/ICE routing by peer id.

Problems:

- During migration, signaling and WebRTC modules disagreed on target identifier naming.
- Risk of broadcasting signaling to wrong recipients while refactoring.

Fixes:

- Unified around `peerId` and `targetPeerId` for teacher-targeted signaling.
- Added per-peer cleanup path when students leave.

### Phase D: Rendering performance and worker pipeline

Successes:

- Main thread no longer does all frame manipulation.
- Worker path supports `PROCESS_FRAME_BITMAP` with `ImageBitmap`.
- `OffscreenCanvas` usage reduced UI stutter during filter operations.

Problems:

- Initial synchronous frame processing caused visible lag.
- Earlier experimental flow had race behavior where processed frames could arrive after render moved on.

Fixes:

- Added `processingInFlight` guard to prevent queue flooding.
- Used bitmap transfer and explicit `bitmap.close()` cleanup in worker.

### Phase E: Focus tracking and accessibility controls

Successes:

- Cursor heatmap + temporal diff fusion drives focus target.
- Focus pane animates with spring smoothing instead of jumping.
- Keyboard support and ARIA labels improved usability.

Problems:

- Focus behavior initially felt noisy under rapid pointer movement.
- Manual focus and auto focus needed clear control handoff.

Fixes:

- Added heatmap decay and confidence visualization.
- Added manual override and keyboard toggle behavior.

### Phase F: Reconnect resilience and cleanup

Successes:

- Student sessions survive temporary disconnects (30s grace window).
- Stale rooms and expired rate-limit entries are swept.

Problems:

- Without null checks, room cleanup logic could crash when teacher references disappeared.

Fixes:

- Hardened abandoned room check for null teacher cases.

## 8. Real Errors and Recovery Notes

| Symptom | Likely Cause | Recovery |
|---|---|---|
| `Port 8082 is already in use.` | Another server process still running | Kill old process or change server port |
| `Cannot reach signaling server.` | Server not running or wrong URL | Start server and verify client points to `ws://localhost:8082` |
| `Protocol version mismatch` | Client bundle older than server protocol | Refresh/rebuild client and restart dev session |
| `This code is invalid or has expired.` | Wrong room code or room garbage-collected | Ask teacher for current code and rejoin |
| `Too many failed attempts. Try again later.` | Join brute-force rate limit triggered | Wait for reset window (15 min) |
| Student stream not appearing | Offer/answer/ICE ordering issue or join race | Reconnect student, verify peer-specific signaling messages |
| Filter feels delayed under load | Worker already processing prior frame | Reduce load, keep `processingInFlight` guard, lower frame rate if needed |

## 9. Conflict Log (Engineering Friction)

1. Message contract drift:
	- Conflict: signaling payload shape changed during hardening while client handlers still expected older fields.
	- Resolution: introduced stable envelope and explicit helper methods in signaling client.

2. Module/test environment split:
	- Conflict: server uses ESM while Jest defaults required extra VM module support.
	- Resolution: server test script runs with `--experimental-vm-modules`.

3. Multi-peer migration:
	- Conflict: previous single `pc` model on teacher side did not map to multiple students.
	- Resolution: replaced with `Map<peerId, { pc, dataChannel }>` lifecycle model.

4. Worker throughput:
	- Conflict: unbounded frame enqueue created processing lag.
	- Resolution: single in-flight processing guard and transferable bitmap path.

## 10. Known Limitations and Open Issues

- Architecture is currently 1:N mesh from teacher browser; large classrooms can stress teacher CPU/network.
- Signaling endpoint is hardcoded to `ws://localhost:8082` in client code.
- Automated tests are mostly unit-level; there is no full browser integration suite yet.
- Focus fusion defines a density weight in config, but current fusion path primarily uses cursor and temporal signals.
- Palette option is passed through processing pipeline but current worker path does not apply per-palette transformations in worker.

## 11. What Went Well

- Reliable test baseline exists for server validation and focus worker logic.
- Security posture improved versus initial prototype.
- Rejoin behavior significantly reduced classroom disruption after transient disconnects.
- Accessibility controls are integrated into runtime UI rather than hidden in configuration.

## 12. Next Steps

1. Add browser-level integration tests for signaling + WebRTC join flows.
2. Externalize signaling URL to environment config.
3. Add optional TURN relay support for restrictive networks.
4. Expand worker-side processing to include palette-aware transforms.
5. Add classroom telemetry for FPS and reconnect metrics.

## 13. Quick Command Reference

From repo root:

```bash
# start server + client
npm run dev

# run server tests
cd server && npm test

# run client tests
cd client && npm test
```

---

If you are evaluating this project for competition/demo use, review Sections 7 through 10 first. They capture the engineering tradeoffs, failure modes, and recovery logic that matter most in a live environment.
