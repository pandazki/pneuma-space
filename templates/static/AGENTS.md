# Pneuma Space static site template

The platform serves `site/` at `/apps/<name>/` with no container, so there is no cold start and nothing to keep running.

- Put the built site in `site/`; `site/index.html` answers the address. Point `dir` in `pneuma.json` elsewhere (for example `dist`) if your build writes there.
- Use relative URLs (`./app.js`, `img/logo.png`), never `/app.js`: the site lives under `/apps/<name>/`.
- There is no SPA fallback; a missing path is 404, so link to real files.
- Publish with `appctl publish <name> . --owner user:<you>`. Publishing again replaces the files.
- For a database, triggers, WebSockets or identity, start from the `app` template; it can still serve its assets this way with `static`.
