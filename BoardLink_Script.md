# BoardLink Presentation Script

**Event:** TSA Software Development | **Time:** 7 minutes max + 3 min Q&A
**Speakers:** A, B, C (all three should practice answering code questions)

---

## Slide 1: Title (Speaker A) — ~20 sec

"Hi, we're [team name] from [school]. We built BoardLink, and we're here to show you how it works."

---

## Slide 2: The Problem (Speaker B) — ~50 sec

"So here's the situation. Over 7 million students in the U.S. have some form of visual impairment, and classrooms are still built around the assumption that everyone can see the board perfectly.

If you're a student with low vision, you're stuck. Projectors and whiteboards don't scale. Screen magnifiers exist, but they're static — they can't follow what the teacher is pointing at or where they're writing. And honestly, asking the teacher to repeat things or moving your seat every class just gets old fast. It creates friction, and that matters.

This year's TSA prompt asked us to remove barriers for people with vision or hearing disabilities. That's where BoardLink comes in."

---

## Slide 3: Our Solution (Speaker C) — ~50 sec

"BoardLink is a real-time screen-sharing app. The teacher shares their screen, and students get their own enhanced view — right on their own device.

There are four main features we want to walk you through. First, the AI Focus Pane — it watches three signals: where the teacher's cursor is, where there's motion on screen, and where strokes are dense. It fuses those together and auto-zooms on the area that matters most.

Second, Bold-Ink filters. These apply morphological dilation to make thin text and diagram lines thicker and darker. Three intensity levels.

Third, we built six color palettes — including modes optimized for cataracts and tritanopia. Students switch in real time.

And fourth, a freeze-frame feature. Hit spacebar, and the current frame gets captured for reference while the live feed keeps running."

---

## Slide 4: Design Process (Speaker A) — ~45 sec

"We started by talking to students and teachers at our school about what actually causes visibility problems in class. That shaped our requirements — simple teacher setup, quick student join, and tools that work in real time without asking students to configure anything complicated.

We built a proof of concept with WebRTC and a basic canvas renderer, tested it with classmates, and realized we needed a lot more. Tester feedback pushed us to add the focus tracking, the ink filters, and the color palettes. We ended up rewriting the rendering pipeline to use Web Workers so the student's UI stays smooth while all the image processing happens off-thread.

Final round was accessibility audits against WCAG 2.1 AA and load testing with 15 simultaneous connections."

---

## Slide 5: Architecture (Speaker B) — ~40 sec

"Here's how it all fits together. The teacher starts a screen capture. That goes to our Node.js signaling server over WebSocket, which handles room creation and WebRTC negotiation. Once signaling is done, the video stream goes peer-to-peer — teacher directly to each student through individual RTCPeerConnections.

On the student side, frames get pulled off the video track and rendered to a canvas. If filters are on, frames go to a Web Worker for processing, come back as ImageBitmaps, and get composited. The focus pane runs in its own worker, doing the attention fusion at a downsampled resolution so it doesn't block the main thread.

Tech stack — vanilla JavaScript, no frameworks. Vite for bundling. Zod for input validation on every WebSocket message. nanoid for room codes."

---

## Slide 6: Live Demo (Speaker C) — ~90 sec

"Let's show you. [Opens teacher view on laptop]

So the teacher clicks 'I am a teacher,' starts their screen share, and gets a four-character room code — you can see it here.

[Opens student view on phone/second tab]

Now I enter that code on the student side. Connection takes under a second. You can see the teacher's screen streaming live.

Let me turn on the Bold-Ink filter — watch the text get thicker. That's the morphological dilation running in a Web Worker. I'll cycle through the levels: light, medium, heavy.

Now I'll switch the color palette to high-contrast warm. And here's the cataracts-optimized mode.

See this yellow glow following the cursor? That's the CursorGlow — it uses lerp-based smoothing so it doesn't jitter.

And the focus pane down here — it's tracking where the action is on the teacher's screen. If I move the cursor around, it follows. If I write something, it shifts to that.

Last thing — spacebar to freeze. The frame gets captured in a picture-in-picture overlay. Students can reference it without losing the live stream.

That's BoardLink in action."

---

## Slide 7: Under the Hood (Speaker A) — ~40 sec

"A few things worth highlighting on the complexity side. This is a 1:N WebRTC mesh — the teacher opens a separate peer connection for each student, not a broadcast. That gives us independent data channels for cursor tracking.

The focus AI fuses three signals: cursor position at 45% weight, temporal motion detection at 35%, and stroke density at 20%. Those get fed through spring physics so the zoom window moves smoothly instead of jumping around.

All image processing lives in Web Workers. We use OffscreenCanvas and transfer ImageBitmaps as transferable objects — that means zero-copy handoff between threads.

On security — Zod validates every incoming message. We rate-limit join attempts to prevent brute-forcing room codes. There's a 4KB payload cap on the data channel and a garbage collector that sweeps stale rooms every 60 seconds."

---

## Slide 8: Accessibility (Speaker B) — ~30 sec

"Accessibility is the whole point, so we took it seriously. Six color palettes covering the most common vision conditions — not just high contrast, but modes specifically tuned for cataracts and color blindness.

Focus rings exceed a 7:1 contrast ratio, which is actually WCAG AAA, not just AA. Touch targets are a minimum of 48 pixels. Full keyboard navigation — spacebar freezes, Shift+F cycles filters. ARIA live regions announce status changes for screen readers.

And the one-click teacher setup with four-character room codes — that's a cognitive accessibility choice. We didn't want the tool itself to be a barrier."

---

## Slide 9: Testing & Practices (Speaker C) — ~30 sec

"Testing — we wrote unit tests with Jest for the server-side Zod validation, room lifecycle logic, and rate limiting. Integration testing meant running one teacher and multiple students in browser tabs simultaneously. We did a full WCAG 2.1 AA audit across all six color palettes, and we load-tested with 15 concurrent connections to make sure frame rates held up and reconnection worked under stress.

On the coding side — each concern lives in its own ES module. Signaling, WebRTC, each UI component, each worker. Heavy processing never touches the main thread. And features degrade gracefully — if the focus AI can't compute, students still see the full stream. Nothing blocks."

---

## Slide 10: Closing (Speaker A) — ~15 sec

"That's BoardLink. Every student deserves to see what's being taught. We're happy to answer any questions."

---

## Q&A Prep (3 minutes)

### Likely judge questions and who should answer:

**"Walk me through a specific section of code."**
All three should be able to explain any file. Practice these:
- Server: Zod schema validation, room creation flow, rate limiting logic
- Client: WebRTC setup, how the rendering loop works, how workers process frames
- Workers: Bold-Ink dilation algorithm, focus attention fusion math

**"Why vanilla JS instead of React?"**
(B or C) "We wanted to keep the bundle small and the runtime overhead low. This app is real-time video processing — every millisecond of framework overhead matters. Plus, the architecture is simple enough that a framework would just add abstraction we don't need."

**"How does the AI focus tracking work?"**
(A) "Three signals get fused. Cursor position gets a Gaussian heatmap that decays each frame. Temporal difference compares consecutive frames pixel-by-pixel to find motion. Stroke density looks at how much ink is in each region. Each signal is weighted — 45, 35, 20 — and combined into an attention map. The highest-attention coordinate drives the zoom window through spring physics so it moves naturally."

**"What happens if the network drops?"**
(B) "We store the session ID in sessionStorage. If the WebSocket disconnects, the server holds a grace session for 30 seconds. The client auto-reconnects and sends a REJOIN_ROOM message with the stored session ID. The server matches it, restores the peer connection, and the student resumes without re-entering the room code."

**"What was the hardest part?"**
(C) "Getting the worker pipeline right. Sending frames to a worker, processing them, and getting them back without blocking the main thread or leaking memory. We went through several iterations — raw ImageData, then createImageBitmap with transferable objects. The current version uses zero-copy transfers but we had to be careful about closing bitmaps after use."

**"How did you test accessibility?"**
(A) "Manual audit against WCAG 2.1 AA checklist. We checked focus visibility, color contrast ratios, keyboard navigation paths, and screen reader announcements. We tested each of the six palettes independently because contrast requirements change depending on the active palette."
