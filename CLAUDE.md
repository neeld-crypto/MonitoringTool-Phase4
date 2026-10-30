# Pulse

Stream player and SRT / UDP / HLS monitoring wall by Skandha Media Services. Node.js + Express backend, React frontend.

## Layout

```
server.js            entry: starts the server
src/
  index.js           start(): listen, shutdown, desktop-app behaviour
  app.js             Express app: mounts the routers and serves the frontend
  apps/              one folder per API area (routes only): srt, proxy, system
  config/            environment and paths
  constants/         MIME types, limits, SRT / alert defaults
  libraries/         wrappers around external tools
  parser/            stream parsing: MPEG-TS analyser, SCTE-35, HLS, ffmpeg output
  services/          business logic: monitor, channels, sessions, alerts, notifiers
  utilities/         shared helpers tied to this app (http, static files, desktop)
  utils/             small pure helpers
test/                backend tests (Vitest, *.test.js)
frontend/            React app (Vite); its own package.json and tests
deploy/linux/        Ubuntu helper scripts; scripts/ builds the Linux and Windows packages
```

## Commands

- `npm run install:all`, then `npm run build` (builds the frontend), `npm start` (http://localhost:4173)
- `npm run dev` (backend with reload) and `npm --prefix frontend run dev` (frontend on 5173, proxying to the backend)
- `npm test` (backend) and `npm run test:frontend`
- `npm run build:linux`, `npm run build:exe`

## Rules

See CLAUDE_RULES.md. The HTTP API is documented in FRONTEND_API.md.
