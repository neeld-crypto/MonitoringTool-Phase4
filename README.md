<p align="center">
  <img src="public/skandha-logo.png" alt="Skandha Media Services" width="140">
</p>

# Pulse

Skandha Media Services stream player and live monitoring wall. Plays MPEG-DASH and HLS (with DRM and SCTE-35 inspection) and monitors many SRT, UDP/multicast and HLS channels at once, with alerts and history.

## Features

- **Player:** DASH / HLS, Widevine and FairPlay, "stats for nerds", audio levels and loudness, SCTE-35 decoding.
- **Monitoring wall:** live tiles for SRT, UDP and HLS channels (grid 2x2 to 8x8, fullscreen), a preview and a full analysis panel per channel.
- **Alerts:** black video, audio silence, ad breaks on the tiles; packet loss, PCR / continuity errors, bitrate and more in the analysis, with Slack / email notifications.
- **History chart:** bitrate / RTT with alert markers, pan back in time, filter by alert type, jump to a date and time.

## Run

Requires Node 22.12+, and ffmpeg for SRT / UDP monitoring.

```bash
npm install
npm run dev        # development, http://localhost:5173
npm run build      # production build
npm start          # serve the build with the monitoring server (port 4173)
npm test           # unit tests
```

## Package for a server

```bash
npm run build:linux   # release/playprobe-linux.tar.gz for Ubuntu (see deploy/linux/README-LINUX.txt)
npm run build:exe     # Windows installer and portable build
```

On Ubuntu, `HOST=0.0.0.0 ./start.sh` serves the page on the server's IP (there is no login, so use a trusted network).

## Branches

`main` (release) · `staging` (testing) · `development` (daily work)

## Docs

More detail in [docs/](docs/). Based on the open-source PlayProbe project (MIT, see [LICENSE](LICENSE)).
