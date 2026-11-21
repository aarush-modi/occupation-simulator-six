# Workshift

Type an occupation (or say it out loud) and play a short first-person 3D work shift, solo or with a guest who joins
by QR code. Gemini designs the shift, the Node backend validates it and runs the shared simulation, and your webcam
drives the avatar. See [REQUIREMENTS.md](REQUIREMENTS.md) for the product spec.

- `frontend/`: Next.js 16 (App Router) + React Three Fiber. Use it as the Vercel project root.
- `backend/`: one long-running Node process: HTTP API, WebSocket rooms, 20 Hz server simulation, Gemini generation.
- `frontend/src/shared/`: schema, validation and simulation code shared by both sides.

## Quick start

Node 22 or newer. From the repository root, in two terminals:

```sh
npm --prefix frontend install
npm --prefix backend install
cp backend/.env.example backend/.env        # add GEMINI_API_KEY
npm run dev:frontend                         # http://localhost:3000
```

```sh
npm run dev:backend                          # http://localhost:3001/health
```

Without `GEMINI_API_KEY`, generation fails straight away and the host picks a labeled demo shift in the same lobby
(this is the intended recovery path, F7).

## Playing on two laptops (HTTPS)

Browsers only allow the camera and microphone in a secure context. `http://localhost` counts, but a guest opening
`http://192.168.x.x:3000` cannot use the webcam, so for two laptops run both servers over HTTPS on the host laptop:

```sh
npm run dev:frontend:https    # next dev --experimental-https -H 0.0.0.0
npm run dev:backend:https     # HTTPS=1: backend serves https and wss on :3001
```

1. Start the frontend first. On its first run, Next downloads [mkcert](https://github.com/FiloSottile/mkcert),
   installs a local CA (it may ask for your password) and writes `frontend/certificates/localhost-key.pem` and
   `localhost.pem`. The folder is gitignored.
2. The backend, started with `HTTPS=1`, reuses that certificate. It prints `listening on https://<LAN IP>:3001 (WebSockets: wss)`.
   To use a different certificate, set `HTTPS_KEY` and `HTTPS_CERT` (file paths) instead.
3. On the host, open `https://localhost:3000`. Create a shift. The QR code and invite link point at
   `https://<LAN IP>:3000/shift?room=...`.
4. **On the guest laptop, accept two certificate warnings.** The mkcert certificate is trusted only on the machine
   that created it, and it is issued for `localhost`, not the LAN IP. The guest must:
   - open `https://<host LAN IP>:3001/health` and click through the warning ("Advanced" -> "Proceed"), so that
     API calls and the `wss://` socket to the backend work. You only need to do this once per browser session.
   - open the invite link and click through the same warning for `:3000`.

   If the lobby says "Could not reach the shift server", the guest has usually skipped the `:3001` step.

The frontend finds the backend at `<page protocol>//<page host>:3001`, so an https page automatically talks to
`https://...:3001` and `wss://...:3001`. In development the backend accepts any localhost / private-LAN origin over
http or https. Both laptops must be on the same network, and the host firewall must allow ports 3000 and 3001.

## Environment variables

Backend (`backend/.env`, see [backend/.env.example](backend/.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Backend port |
| `GEMINI_API_KEY` | none | Gemini key. It stays on the backend. |
| `GEMINI_MODEL` | `gemini-4-carbon` | Model for scenario generation. Override it to compare latency. |
| `GEMINI_BUDGET_MS` | `8000` | Total time budget for one generation, covering both attempts |
| `GEMINI_THINKING` | `MINIMAL` | `thinkingConfig.thinkingLevel`. Dropped automatically for models that reject it. `none` disables it. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Comma-separated allowed origins. LAN origins are also allowed unless `NODE_ENV=production`. |
| `HTTPS` | unset | `1` serves HTTPS/WSS using `frontend/certificates/` |
| `HTTPS_KEY`, `HTTPS_CERT` | unset | Paths to a TLS key and certificate. These take precedence over `HTTPS=1`. |
| `PUBLIC_FRONTEND_URL` | unset | Base URL for invite links, e.g. a Vercel deployment. Otherwise links use `http(s)://<LAN IP>:3000`. |
| `FRONTEND_PORT` | `3000` | Port used in LAN invite links |
| `FRONTEND_HTTPS` | unset | `1` forces https invite links even when the backend itself runs plain http |

Frontend (`frontend/.env.local`, see [frontend/.env.example](frontend/.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | `<page protocol>//<page host>:3001` | Backend origin. On Vercel, set it to the backend's HTTPS origin. |

Each generation appends one JSON line to `backend/logs/generation.jsonl` and logs `[gemini] ...` to the console.
The line records the model, response time, token usage, cache hits, whether the first attempt passed validation, and
running totals (`cacheHitRate`, `firstPassRate`) (N2). `GET /health` also reports these totals.

## Spoken prompts

The mic button next to the occupation field records up to 6 seconds. Press it again to stop early. The clip is
converted to 16 kHz mono WAV in the browser and posted to `POST /api/rooms` as
`{ audio: { mimeType, data: <base64> } }`. The room is created at once with the occupation "Spoken request". The
clip goes to Gemini as an `inlineData` part in the same single generation request, and the model fills in
`blueprint.occupation`. When generation succeeds, the room and the lobby UI switch to the inferred occupation.
Audio is sent only when the host records, and the backend drops the clip after the request. Spoken requests are
never answered from the cache, but their blueprint is cached under the inferred occupation. The microphone needs a
secure context (localhost or the HTTPS setup above). If permission is denied, the lobby shows a message and typing
still works.

## Demo shifts

Hand-authored, prevalidated blueprints in `backend/src/demos/` (currently `barista` and `bartender`). When generation
fails or takes longer than 8 seconds, the host's lobby offers them. Selecting one loads it into the same room with
the same invite (`POST /api/rooms/:id/demo`).

## Routes

| Route | What it is |
|---|---|
| `/` | Lobby: type or say an occupation, or pick a suggested job |
| `/shift?room=<id>` | A shared shift room. The host arrives with `&host=1`. Guests arrive here from the QR code or invite link. |
| `/play` | Featured hand-built shift: offshore drilling rig floorhand (single player) |
| `/dev/props` | Prop catalog viewer |
| `/dev/shells` | Room shell viewer |

Backend: `GET /health`, `GET /api/demos`, `POST /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms/:id/demo`,
`WS /room/:id`.

## Webcam modes

Tracking runs on-device with MediaPipe. Only compact poses and action intents leave the browser. Each player
calibrates their own webcam. The choice of mode is remembered per browser.

- **Full body** (default): stand back so your whole body is in frame. Run in place to move, turn your torso to steer,
  reach to grab, lower both hands to place, and push and hold to press.
- **Seated**: face and hands only, for a laptop at a desk. Lean to move, turn your head to steer, and use hand
  gestures to interact.

Keyboard and mouse (WASD) also work for testing without a camera.

## Tests

```sh
cd backend && npm test      # node --test: validation, simulation, NPCs, HTTP + WebSocket rooms, spoken prompts
node frontend/scripts/catalog.mjs                                         # validate and rebuild the prop catalog
node --env-file-if-exists=backend/.env backend/scripts/try-gemini.mjs barista beekeeper   # live Gemini check (needs a key)
```
