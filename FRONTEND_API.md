# Frontend API

The Express backend (`server.js`, port 4173) serves the built frontend and these endpoints. All of them are for local / trusted-network use and need a signed-in session (cookie `pulse_session`, see Sign-in below); without one pages redirect to `/login` and the APIs answer 401. Requests with a foreign `Origin` are refused (403). Errors are `{ "error": "message" }` with status 400, 403 or 404.

In development the Vite server (port 5173) proxies `/__srt`, `/__proxy`, `/__app`, `/__layouts`, `/__auth` and `/login` to the backend (`BACKEND_URL`, default `http://127.0.0.1:4173`).

## Sign-in (`/login`, `/__auth`)

One shared user name and password, from `PULSE_USER` / `PULSE_PASSWORD` (default `admin` / `admin`). `PULSE_AUTH=off` disables it; `PULSE_SESSION_HOURS` sets how long a sign-in lasts (default 12). Sessions are kept in memory, so a restart signs everyone out. Five wrong passwords lock that address for a minute (429). The cookie is `HttpOnly` and `SameSite=Strict`. `POST /__app/quit` from the server's own machine needs no sign-in (the uninstaller uses it).

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/login` | | the sign-in page (query `next`: the page to open afterwards) |
| POST | `/__auth/login` | form `user`, `password`, `next` | sets the session cookie and redirects (303); 401 or 429 shows the page again with the reason |
| POST | `/__auth/logout` | | ends the session: `{ ok: true }` |
| GET | `/__auth/status` | | `{ enabled, user }` (401 when not signed in) |

## System (`/__app`)

| Method | Path | Result |
| --- | --- | --- |
| GET | `/__app/info` | `{ desktop }`: true when the single-file executable is running |
| POST | `/__app/quit` | stops the server (executable only) |

## Layouts (`/__layouts`)

Saved arrangements of channels on a screen, stored in `.playprobe/layouts.json`. A layout is `{ id, name, aspect, cells }`: `aspect` is `16x9`, `4x3`, `21x9` or `1x1`, and each cell is `{ x, y, w, h, channel }` on a 24 × 24 grid (`channel` is a channel id or null).

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/__layouts` | | `{ layouts }` |
| PUT | `/__layouts` | `{ layouts }` | replaces the whole list (at most 64 layouts of 64 cells); returns `{ layouts }` |

## Monitoring (`/__srt`)

Every call that changes something returns the full status object.

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/__srt/status` | | capabilities, channel snapshots, alert history, settings |
| GET | `/__srt/events` | | server-sent events: `status`, `snapshot`, `alert`, `scte`, `log`, `notify` |
| GET | `/__srt/load` | | CPU / memory of the machine, the server and its ffmpeg processes |
| GET | `/__srt/interfaces` | | IPv4 network cards of the server's machine: `{ interfaces: [{ name, address, internal }] }` (for the UDP form's interface list) |
| POST | `/__srt/channels` | `{ kind: 'srt' \| 'udp' \| 'hls', name? }` | add a channel |
| POST | `/__srt/bulk` | `{ items: [{ name?, config }], start }` | add many, optionally start them |
| POST | `/__srt/ch/:id/start` | `SrtConfig` | start a channel |
| POST | `/__srt/ch/:id/stop` | | stop it |
| POST | `/__srt/ch/:id/copy-rules` | | copy this channel's alert rules to all channels |
| POST | `/__srt/ch/:id/watch` | | make this the channel with a browser preview |
| PUT | `/__srt/ch/:id` | `{ name, thresholds }` | rename / change alert rules |
| DELETE | `/__srt/ch/:id` | | stop and remove |
| POST | `/__srt/start-all`, `/__srt/stop-all` | | start-all launches one by one and stops at the CPU limit |
| PUT | `/__srt/limits` | `{ maxCpuPct }` | no new channel starts above this machine CPU |
| PUT | `/__srt/notify` | webhook / email settings | shared notification settings |
| POST | `/__srt/notify-test` | `{ ch? }` | send a test alert to the enabled channels |
| GET | `/__srt/thumb/:n.jpg` | | small live picture of channel n, for the wall |
| GET | `/__srt/hls/ch<n>/<file>` | | HLS preview written by ffmpeg |

Everything is also written to `logs/<YYYY-MM-DD>/`.

## CORS proxy (`/__proxy`)

`GET /__proxy/https/cdn.example.com/path/master.m3u8?x=1` fetches `https://cdn.example.com/path/master.m3u8?x=1` on the server and adds CORS headers. `POST` is accepted for DRM licence requests only. Custom request headers are sent as `X-Proxy-Header-<Name>`. `GET /__proxy/health` returns `{ status: 'ok' }`.
