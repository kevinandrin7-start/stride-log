# Stride Log

A home-screen training app for a 30-week marathon plan.

- The app (`index.html`, `sw.js`, `manifest.json`, `config.js`) is served by GitHub Pages.
- The server (`worker/`) runs on Cloudflare Workers with a D1 database. It handles sync, screenshot reading (Claude API), the nightly Health import and push reminders.
- `.github/workflows/deploy-server.yml` deploys the server on every push to `worker/` and writes its address into `config.js`.
- `SETUP.md` has the one-time setup steps.
