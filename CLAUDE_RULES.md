# Rules

- Backend: Node.js + Express, plain JavaScript (ES modules). Frontend: React.
- Routes stay thin: they parse the request and call a service. Logic lives in `services/`, parsing in `parser/`.
- Keep the folder layout in CLAUDE.md. New API areas go in `src/apps/<name>/<name>.routes.js`.
- Any API change is written up in FRONTEND_API.md in the same change.
- Never commit secrets: `.playprobe/` (saved settings, webhooks), `logs/` and `release/` stay out of git.
- The monitoring APIs start processes and have no login: bind to localhost or a trusted network only.
- Add or update a Vitest test for every parser, alert rule or service change. `npm test` must pass before merging.
- Branches: `development` for work, `staging` for testing, `main` for releases.
