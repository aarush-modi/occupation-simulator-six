# Workshift simulator requirements

## Product goal

A player names an occupation they want to try. Workshift generates a short, interactive 3D shift centered on a representative task. Each player experiences the shift in first person, seeing the workplace from their avatar’s eye level and performing the task through webcam motion capture. They can play solo or invite a guest by QR code.

The hackathon demo targets one indoor workplace per shift, one or two players, and a session that takes a few minutes. The first benchmark occupations are barista, warehouse picker, and florist. Each should teach a different sequence of work, such as operating a machine, sorting items by order, or assembling a set of materials.

## Functional requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| F1 | The host enters a typed occupation or records a short spoken request. OpenAI chooses a representative task and outputs a structured scenario. | An unseen occupation prompt produces a playable shift with a recognizable task and a clear finish condition. |
| F2 | The builder assembles a workplace suited to the requested occupation using a venue enclosure, floor materials, lighting, signs, and interactive equipment. | A sushi shift looks like a sushi bar, other occupations can use distinct indoor, open-front, or outdoor venues, and each required station stays reachable. |
| F3 | The browser requests webcam access when a player enters a shift. A wave or shoulder raise starts play. Raising both shoulders moves the avatar forward, relaxing them stops movement, and head turns steer. Face and shoulder framing supports play from a seated position. Pinching picks up a focused prop, opening the pinch places it, and a palm push or pinch activates a focused control. | A player completes a task using webcam motion alone. Bending to reach for a prop does not trigger locomotion. |
| F4 | Objects can be picked up, carried, handed off, and placed. Machines check prerequisites and give feedback when operated. | The espresso machine responds when a cup is seated and the player presses the control. The finished cup can be placed on the pickup counter. |
| F5 | The host can play solo or share a QR code and copyable link. Guests can join while the scenario generates. | Two HTTPS-connected laptops share a room, see the same state, and can hand off a prop. Simultaneous grab requests grant a single hold. |
| F6 | NPCs navigate between stations, act out background work, and start conversations with nearby players. The event director can introduce an occupation-relevant complication. | A station closure changes the destination and NPC instructions. Players can complete the revised task together. |
| F7 | The UI shows the current task, reachable target, tracking state, and shift result. The host can select a labeled demo shift when generation fails or times out. | The host can recover in the same lobby, using the same invite. |
| F8 | Gameplay uses a first-person camera at the local avatar’s eye level. Tracked hands and held props appear in view when they enter the field of view. Other players appear as avatars in the world. | Each player sees from their own avatar’s viewpoint and can visually guide a reach, pickup, handoff, and placement. |
| F9 | The scenario director chooses supported mechanics and configures shared rules for a new game. NPCs can cooperate with the players or compete against them. | A boxing prompt creates a five-sided ring with rounds, points, an NPC rival and upper-body webcam controls. A timed work challenge uses job-specific tasks and an allied or rival NPC. Players in each room see the same outcome. |

## Non-functional requirements

| ID | Requirement | How to verify |
|---|---|---|
| N1 | Aim for a playable generated room within five seconds of prompt submission. Offer the demo shift at eight seconds. | Measure time to room-ready and time to first successful grab separately on first and repeat loads at the venue. |
| N2 | Use one bounded OpenAI generation request per new room and allow one repair attempt. Coworker planning can use a smaller model. The room server governs movement, game state, and event timing. | Record model, response time, token usage, and first-pass validation rate. |
| N3 | Run physics and task state on the server. Start with a fixed physics step and roughly 20 snapshots per second. | Test two laptops under latency, simultaneous grabs, late joins, and disconnects. Interpolate remote movement. |
| N4 | Process webcam video on-device. Send compact avatar poses and action intents. Send a short audio clip to Gemini only when the host chooses to record a prompt. Keep the key on the backend. | Inspect browser requests and WebSocket messages. Confirm camera and microphone permission flows over HTTPS. |
| N5 | Recover from tracking loss, failed generation, and invalid blueprints. The server stops stale movement and releases held props after a short grace period. | Cover each failure in a local simulation or two-laptop test. |
| N6 | Keep deployment to a Next.js frontend and one long-running Node backend. Rooms and cache are disposable across restarts. | Run both apps locally and exercise a Vercel preview against one HTTPS/WSS backend. |
| N7 | Keep first-person camera motion comfortable during webcam-controlled movement. Smooth noisy heading changes and avoid forced camera bob. | Move, turn, and stop with the laptop webcam framing the upper body. Confirm the view settles when the player stops and remains readable while reaching. |

## Architecture and workflow

```mermaid
flowchart LR
    P["Player enters an occupation"] --> F["Next.js lobby and QR invite"]
    F --> A["Node scenario API"]
    A --> G["OpenAI blueprint"]
    G --> V["Validation and room assembly"]
    V --> R["Room server · physics, NPCs, events"]
    C["Webcam · local MediaPipe tracking"] --> F
    F <-->|"WebSocket · motion intents and shared state"| R
```

1. **Open the lobby.** The frontend preloads the renderer, tracking model, and common assets. Creating a lobby returns a room ID immediately so the host can share it while generation runs.
2. **Generate the scenario.** The backend sends the occupation and catalog to the OpenAI Responses API using Structured Outputs. It defaults to `gpt-6.2-astra`. Set `OPENAI_API_KEY` in `backend/.env` and use `OPENAI_MODEL` to select another compatible model. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
3. **Validate and assemble the scene.** Zod checks the schema. Semantic checks verify unique IDs, valid references, prop placement, available actions, and reachability before and after events. The builder maps station and prop IDs to reusable geometry, colliders, grip points, and interaction zones. Fixed layout anchors let the scene load quickly.
4. **Enter the shared world.** Each browser loads the validated blueprint and requests camera access on entry. React Three Fiber renders the room at the local avatar’s eye level. MediaPipe uses upper-body pose for movement, face tracking for view direction, and hand tracking for gestures and visible hands. The browser highlights reachable objects and sends poses and interaction intents over WebSocket.
5. **Run the shift.** Rapier and the room server resolve movement, holds, collisions, placement, and task progress. NPCs use goal-based state machines. The event director checks live conditions and applies changes to stations, NPC goals, and objectives together.
6. **Finish or recover.** Show the outcome when the job task is complete. When generation times out or fails validation, the host can explicitly select a prevalidated demo shift in the same room.

### Blueprint and network contracts

| Contract | Planned contents |
|---|---|
| **Scenario blueprint** | Schema version, occupation and briefing, stations and layout anchors, prop definitions, ordered objectives, NPC goals and dialogue, and an event with a trigger, effect, and recovery path |
| **HTTP** | `POST /api/rooms` starts a lobby and generation job. `POST /api/rooms/:id/demo` lets the host select the prevalidated fallback. |
| **WebSocket** | `/room/:id` joins a lobby. The server sends lobby status, the selected blueprint, and a room snapshot. Clients send poses, movement intents, and grab, place, or press requests. The server validates these requests and broadcasts authoritative results. |

A generated scenario composes engine capabilities. The initial verbs are **move, grab, carry, place, and press**. For example, a barista must seat a cup, operate the machine, and deliver the drink. A warehouse picker sorts specified items into the correct bins using the same carry and placement rules. Add new physical behaviors as reusable engine capabilities.

## Implementation milestones

1. **Specify the gameplay contract.** Hand-author a barista scenario and a warehouse scenario with different objectives. Verify they fit one blueprint and model the jobs recognizably.
2. **Prove first-person motion interaction.** Build a single workstation. With the player’s face and shoulders framed by the webcam, verify movement and steering. Confirm hand gestures can pick up and place objects, and check camera stability and tracking loss.
3. **Prove shared physics.** Connect two laptops by QR and WebSocket. Verify that each player sees from their own viewpoint, can see the other avatar, and sees the same result after a handoff. Test one-holder arbitration and a late join.
4. **Add NPCs and an event.** Tie an NPC's instructions to live task progress. Verify that the director can change a task and still leave an achievable outcome.
5. **Connect OpenAI and rehearse.** Generate an unseen occupation from typed and spoken prompts. Measure latency and first-pass validation. Rehearse the fallback and the QR flow on the demo network.

## Scaffold and local setup

- [frontend](frontend) contains the Next.js App Router scaffold. Use it as the Vercel project root.
- [backend](backend) contains the Node server scaffold. Its current route is `GET /health`. Run the eventual room server as one long-running process so both players use the same in-memory simulation. Vercel Functions can accept WebSockets, and separate connections can land on different instances. [Vercel WebSocket connection behavior](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)

With Node 22 or newer, run the commands in two terminals from the repository root.

```sh
npm --prefix frontend install
npm run dev:frontend
```

```sh
npm run dev:backend
```

The frontend defaults to `http://localhost:3000` and the backend health check to `http://localhost:3001/health`. For the integration milestone, copy the frontend example to `frontend/.env.local` and the backend example to `backend/.env`. On Vercel, set `NEXT_PUBLIC_BACKEND_URL` to the backend's HTTPS origin. Configure the corresponding `FRONTEND_ORIGIN` on the backend when adding HTTP and WebSocket origin handling.
