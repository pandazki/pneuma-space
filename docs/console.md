# Console standard

The console is one file, `gateway/src/console.html`: tokens, controls, pages and the two dictionaries. Every page follows this file. A page that cannot follow it shows a gap in this file; fix the standard first, then the page.

## Method

Before a page changes, write down three things in order:

1. **Data.** What records exist, which fields, how many, how fast they change.
2. **Consumption.** The question the reader arrives with, what they compare, what they act on.
3. **Form.** Only then the layout and controls.

Grouping, hierarchy, status and time come before tables. A table is allowed only where the reader scans homogeneous records and loses no grouping, status or time order by it: releases, trigger deliveries, raw warning lists. Everything else is a list of rows or cards grouped by what the reader asks first (state, tenant, pressure). Within a group, the worst sorts first.

## Type and space

| Role | Size | Notes |
| --- | --- | --- |
| Page title | 21/28, 600 | One per page |
| Section title | 13/18, 600 | With a mono index `01` and one muted line under it |
| Body, row titles | 13/20 | Inter |
| Secondary | 12.5 | `--ink-2` |
| Meta, hints | 12 | `--ink-3` |
| Identifiers, numbers | 11.5 to 12 mono | Tabular numerals; app names, Pods, ids |
| Key numbers | 24/32 mono, 600 | One per tile |

Spacing steps are 4, 8, 12, 16, 24, 32, 40 px. Cards pad 16 (12 under 560 px). Sections pad 40 32 (24 20 under 900 px). Radii: 6 chips, 8 inputs and menu items, 10 menus, 12 cards and rows, 999 buttons and segmented controls.

## Colour roles

Tokens live on `:root` and `:root[data-theme="dark"]`; nothing hard-codes a colour.

| Role | Tokens | Means |
| --- | --- | --- |
| Ground | `--page`, `--canvas`, `--surface`, `--inset`, `--field` | Page, recessed panel, card, chip, input |
| Ink | `--ink`, `--ink-2`, `--ink-3` | Primary, secondary, meta |
| Line | `--line`, `--line-strong` | Hairline rings (`box-shadow: 0 0 0 1px`), never solid borders on cards |
| Accent | `--accent`, `--accent-ink`, `--accent-tint` | Interactive: links, the primary button, focus, selection. Never a status |
| Green | `--green`, `--green-tint` | Up, awake, done |
| Orange | `--orange`, `--orange-tint` | In transit, attention without failure, capacity near its limit |
| Red | `--red`, `--red-tint` | Failure, down, stuck, quarantined; the destructive item inside a menu and its approval |

A status is a dot plus a word (`.st`). Red text appears only for a failure or inside a ⋯ menu and its approval card.

## Controls

There is one of each. No native `<select>`, no OS-styled file input, no checkbox outside a toggle chip.

- **Buttons by weight.** `.btn.primary`: the one action the page or form exists for. `.btn`: a neutral filled action. `.btn.ghost`: a quiet, edged action for safe, frequent, reversible operations in rows (stop, restart, open); it acts at once, no modal. `.ibtn`: an icon. A control is never a bare word: every clickable carries an edge, a fill or an icon.
- **Segmented** (`segmented`): two to four mutually exclusive options always visible: theme, language, time window, access, role, token kind, database engine.
- **Listbox** (`listbox`): one choice from a list that can grow (tenant scope, move to tenant, state filter, publish tenant). A button showing the value and a chevron opens a menu-pattern list; the chosen item carries a check; past eight items a filter field leads the list. Arrow keys, Enter, Escape, type-ahead.
- **Filter chips** (`.fchip`): dot, label, count; one pressed per field. **Toggle chips** (`.tog`): independent on/off filters.
- **Chips** (`.chip`): identifiers and kinds, mono; `.chip.text` for a word.
- **Inputs**: one style for text, number, search and textarea. A file is chosen with `fileField`: a quiet button plus the chosen name and size, and the whole field accepts a drop.
- **⋯ menu** (`moreMenu`): every destructive or capacity action (remove, purge, force release, drain, scale, Pod restart, revoke, remove member, move tenant). Destructive items come last, red only inside the menu, each with a one-line note.
- **Approval card** (`approve`): after a ⋯ item. Title names the object, the body says in plain words what will happen and what stays, facts list the objects affected, then Cancel and Continue. It is the only confirmation dialog.
- **Empty state** (`.empty`): one sentence of what is absent and, when there is one, the action that fills it.
- **Live indicator** (`liveHeader`): dot and word (live, paused, offline), the age of the latest arrival, and Pause or Resume.
- **Relative time**: `ago` or `agoTick`, ticking each second; the absolute time is the title.
- **Outcome line**: the result of an operation sits under the object it changed, with a quiet Dismiss; it clears itself when the state it reports is gone.

Every control has an accessible name, is reachable by Tab, and works with Enter and Space; menus and listboxes also with arrows and Escape.

## Streams

A live stream shows the newest line on top and holds arrivals behind a pill while hovered or scrolled. Consecutive healthy cycles of one app collapse into one line per app and cycle kind (a wake that reached awake and then asleep; a delivery that finished; both together for a cron tick), counting repeats and showing the mean wake latency. A failure breaks the run and stays its own line. A collapsed line expands to its events; filters match the events inside it.

## Words

Both dictionaries carry every key. Chinese prose holds no English beyond identifiers and kind names (Pod, Node, PVC, app names, field names). Platform reason codes are mapped to words in both languages; an unknown code shows as itself. No milestone names. A fact states what is, not the code that reported it.

## Width

The console is checked at 1440 px and 390 px. At 390 px nothing scrolls sideways: grids drop to one column, rows wrap their meta under the title, toolbars stack, the top bar keeps the tenant listbox and the avatar.
