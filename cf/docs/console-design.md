# Cloudflare console

The visual reference and control rules are [the console standard](../../docs/console.md). The API and permission boundary are [the CF contract](app-contract.md). Browser acceptance is [CF-15 through CF-17](acceptance.md).

## Data

`/me` owns identity, CSRF and tenant roles. Directory lists carry timestamped observations. App detail owns lifecycle, current release, runtime, policy and usage. Separate endpoints own state, releases, jobs and diagnostics. Lists are cursor-paged. Secret responses remain in the current document only.

The console keeps the last response for each read in memory. A view paints its frame and any remembered data in the frame of the click, then revalidates. A region without data holds a skeleton of its final shape that stays invisible for 150 ms and, once visible, for at least 300 ms. Leaving a view aborts its reads. A write clears the memory and refreshes the regions on screen in place. A failed read shows its error and a retry inside its region and keeps what is already shown.

## Consumption

An operator enters `/admin` to find failures, manage accounts and invitations, allocate tenant quotas and inspect resources. A tenant enters `/dashboard` to publish and operate projects, inspect durable data and manage their team and scoped credentials. App operations consult authoritative detail. Each failed API call presents its server code and message beside the relevant operation.

## Form

Both routes use a quiet sidebar, wrapped toolbar, indexed sections, grouped app rows and status words with dots. Admin and tenant navigation are separate. Cards hold resource and account facts. Only releases and deliveries use tables. SQL results use a scrollable text result to preserve wide values without overflowing the page.

Chinese is the default. English and light/dark controls persist locally. The shell stays mounted across navigations. A project keeps its head and an underline tab row while a tab change swaps only the panel. Back and forward restore the scroll position. The navigation becomes a scrollable horizontal bar on narrow screens, where language, appearance and the console switch move into the account menu. Controls retain visible focus. Custom listboxes support arrows, Enter, Escape and type-ahead. File fields use a styled drop target and hidden picker. Destructive actions enter an approval card from a menu. Purge exists only for removed apps and requires the exact app name.

`index.html` serves `/admin` and `/dashboard`. `login.html` serves `/login`; `invite.html` serves `/invite`. All load `/app.js` and `/style.css`. API requests remain under `/api/v1`. Package and object bytes use the returned direct R2 tickets.

## Verification

Syntax checks establish JavaScript parsing only. The root integration run must verify actual deployed workflows and both languages/themes at 1440 and 390 px before claiming CF-17.
