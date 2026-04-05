# Prompt:
Develop a software program that removes barriers and increases accessibility for people with vision or hearing disabilities.

# Initial Implementation plan:

## Phase 1 Implementation Plan: BoardLink Stabilization

This plan outlines the specific execution steps to complete Phase 1 of our Production Blueprint.

## User Review Required

> [!WARNING]
> Please review the dependencies we are adding (Zod for validation on the server) and the approach for OffscreenCanvas. The OffscreenCanvas implementation requires changing the rendering loop. Let me know if you approve this approach!

## Proposed Changes

### Signaling Server (`server`)

#### [MODIFY] [package.json](file:///c:/Users/ishaa/boardlink/server/package.json)
- Add `zod` as a dependency for incoming socket message validation.

#### [MODIFY] [index.js](file:///c:/Users/ishaa/boardlink/server/index.js)
- **Zod Validation**: Introduce Zod schemas for all message payloads (`CREATE_ROOM`, `JOIN_ROOM`, `OFFER`, `ANSWER`, `ICE_CANDIDATE`). Drop invalid payloads and strictly validate the 4-char `roomCode` structure on join.
- **IP Rate Limiting**: Introduce a `failedAttempts` Map caching IP address -> fail counts to restrict brute-forcing `JOIN_ROOM`. Reject attempts after 5 failures in 15 minutes.
- **WebRTC 1:N Logic (Signaling)**: When a student joins, generate a `studentId` using `nanoid`. Pass the `studentId` in the `STUDENT_JOINED` payload to the teacher. Update `OFFER`, `ANSWER`, and `ICE_CANDIDATE` cases to route based on a `targetId` instead of broadcasting to the entire `room.students` set.

---

### Client App (`client`)

#### [MODIFY] [webrtc.js](file:///c:/Users/ishaa/boardlink/client/src/webrtc.js)
- **Multi-Peer Setup**: If `isTeacher` is true, remove the single `this.pc`. Replace it with a `this.peers = new Map()`.
- Expose a `createStudentConnection(studentId)` method for the Teacher. This dynamically creates an `RTCPeerConnection` for each `studentId` that joins, attaches the main track, and initiates the offer targeting *only* that student.

#### [MODIFY] [main.js](file:///c:/Users/ishaa/boardlink/client/src/main.js)
- **Teacher View Updates**: Wire the `STUDENT_JOINED` WebSocket event to call `rtc.createStudentConnection(studentId)` so the teacher handles the new participant correctly.
- **OffscreenCanvas Fix**: Currently, `imageData` is being extracted and copied synchronously. Update the `<video>` frame loop to use `createImageBitmap(video)` and pass the `ImageBitmap` to the worker as a transferable object, reducing main-thread blocking significantly.

#### [MODIFY] [processing-worker.js](file:///c:/Users/ishaa/boardlink/client/src/workers/processing-worker.js)
- Expect an `ImageBitmap` Instead of raw `ImageData` to draw onto the worker's internal `OffscreenCanvas`. Perform the image manipulations and return an ArrayBuffer using transferable objects to guarantee zero-copy performance.

## Open Questions

- Does the teacher app run on a restricted school laptop where heavy CPU processing for multiple concurrent `RTCPeerConnections` might stutter? (For V1 we only support 1:N mesh, but keeping classroom sizes around 15-20 is recommended).

## Verification Plan

### Automated Tests
- Server: We will verify our newly added `zod` schema drops malformed requests.
### Manual Verification
- We will start the `npm run dev` server.
- Connect one Teacher and 2 Students simultaneously in browser tabs to ensure 1:N connectivity and independent DataChannels.
- Verify the video filters continue working without the "Black Screen" issue that was mentioned in code comments.
