# Build and ship this application

This directory is a complete PneumaSpace application. Before editing, publishing, troubleshooting or measuring it, read `.agents/skills/pneuma-space/SKILL.md`. The same skill is installed in the project directories used by Claude Code, Cursor, Gemini CLI and Copilot.

The user's first success is a live, useful application, its measured request timings and a direct link to its dashboard statistics. Evidence that it sleeps naturally and wakes with its data intact comes from `npm run bench`, which waits as long as the app's idle policy; run it when the user is not using the app. Continue through that outcome when the user asks to build or try the starter. `app/` contains the deployable source: `app/public/` is the page shell, which the platform serves from storage without starting the container, `app/server.mjs` is the data API, and `app/space.mjs` calls native storage and runs the scheduled jobs in `app/jobs/`. `PRODUCT.md` and `DESIGN.md` explain this example's purpose and visual choices.

The publishing token is already stored privately. Use the generated commands without reading or printing the credentials file.
