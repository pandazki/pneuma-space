# Cloudflare console

The visual reference and control rules are [the console standard](../../docs/console.md). The API and permission boundary are [the CF contract](app-contract.md). Browser acceptance is [CF-15 through CF-17](acceptance.md).

## Data

`/me` owns identity, CSRF and tenant roles. Directory lists carry timestamped observations. App detail owns lifecycle, current release, runtime, policy and usage. Separate endpoints own state, releases, jobs and diagnostics. Lists are cursor-paged. Secret responses remain in the current document only.

## Consumption

An operator enters `/admin` to find failures, manage accounts and invitations, allocate tenant quotas and inspect resources. A tenant enters `/dashboard` to publish and operate projects, inspect durable data and manage their team and scoped credentials. App operations consult authoritative detail. Each failed API call presents its server code and message beside the relevant operation.

## Form

Both routes use a quiet sidebar, wrapped toolbar, indexed sections, grouped app rows and status words with dots. Admin and tenant navigation are separate. Cards hold resource and account facts. Only releases and deliveries use tables. SQL results use a scrollable text result to preserve wide values without overflowing the page.

Chinese is the default. English and light/dark controls persist locally. The navigation becomes a scrollable horizontal bar on narrow screens. Controls retain visible focus. Custom listboxes support arrows, Enter, Escape and type-ahead. File fields use a styled drop target and hidden picker. Destructive actions enter an approval card from a menu. Purge exists only for removed apps and requires the exact app name.

`index.html` serves `/admin` and `/dashboard`. `login.html` serves `/login`; `invite.html` serves `/invite`. All load `/app.js` and `/style.css`. API requests remain under `/api/v1`. Package and object bytes use the returned direct R2 tickets.

## Verification

Syntax checks establish JavaScript parsing only. The root integration run must verify actual deployed workflows and both languages/themes at 1440 and 390 px before claiming CF-17.
