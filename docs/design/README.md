# Bashreactor, design notes

Why the web app (`apps/web/`) looks and behaves the way it does. This is the design the app is built
against. When this file and the app disagree, one of them is a bug: fix the app, or change this file in
the same commit and say why.

Design read: a working tool for people who run hours-long bash pipelines and want to see what is
running, what failed and why, then fix it and run it again. Dense like an operations console, written
in the Mansus 1-bit language. Dials: ENERGY 2 / RHYTHM 2 / MOTION 1.

## History

The first version (BASHR-8) was drawn at reading size: 17 px text, every control at least 44 px, page
titles up to 88 px, and screens that explained themselves in sentences. It read like a poster and
worked like one. You could see one run at a time, and finding anything meant typing a name.

The redesign (BASHR-50 to 62) keeps the language and changes the scale and the structure. It sits
between that version and Prefect's UI:

- from Prefect: a sidebar, a dashboard, tables you can filter, a run timeline and tabs;
- from Mansus: two inks, dither, the 7×7 signs and the three faces.

`GLOSSARY.md` at the repo root fixes the words. The UI uses Bashreactor's words and never Prefect's:
pipeline, not flow; step, not task; run, not flow run.

## What does not change: the 1-bit language

- **Two inks.** Paper `#e4e2db` and ink `#141414` (14.2:1). There is no other colour, no flat grey,
  and no transparency used as grey. Grey only ever appears as dither: real 2 px squares, so it stays
  1-bit at any zoom.
- **Square corners** everywhere. No `border-radius` and no blur. The one shadow is the hard offset
  shadow.
- **Three faces, three jobs.**
  - Anybody (display) is for the wordmark, the one page title per screen and the dashboard's big
    numbers. Always at 28 px or more.
  - Atkinson Hyperlegible Next is for everything people read.
  - Atkinson Hyperlegible Mono is for code, logs, YAML, ids, hashes, paths and versions.
  - All three are self-hosted (`apps/web/fonts/`), because the CSP is `'self'` only.
- **One 7×7 sign per status.** Each run, step and attempt status has a shape as well as a word,
  drawn cell by cell as crisp SVG (`SIGNS` in `src/client/dom.ts`). A status is always shown as its
  sign and its word together, never as a word alone or a sign alone.
- **Pixel rules.** Rows are separated by a 1 px dotted rule, and panels by a 1 px solid rule.
- **Stamps.** A filled ink label marks a status. An outlined label marks a type (`file`, `integer`,
  `uv`, `admin`).
- **Elevation means "answer this now".** Only dialogs and alarms get the offset shadow.
- **One motion.** The e-ink flash: one frame of ink, then paper, when something changes under the
  reader's eyes, such as a row whose status changed or a run that just appeared. Nothing loops, and
  the flash is off under `prefers-reduced-motion`.
- **Off, not grey.** A disabled control keeps ink for its text, gets a dashed border on a faint dither,
  and the reason it is off is written right beside it in one line.

## What changed: scale

| | Before | Now |
| --- | --- | --- |
| Interface text (tables, nav, buttons, labels, meta) | 17 px | **14 px**, line height 20 px |
| Prose (descriptions, help, empty states) | 17 px | **15 px**, line height 1.5, at most 72ch |
| Code, logs, YAML, ids | 14–15 px | **14 px** mono, line height 1.5 |
| Page title | Anybody, up to 88 px | **Anybody 32 px**, width 50, weight 900, one per screen |
| Section heading | Anybody 28–40 px | **Atkinson Next 16 px, weight 700** |
| Controls and table rows | at least 44 px | **32 px** controls, **36 px** rows; **44 px** for both when the pointer is coarse |
| Panel borders | 3 px | **1 px** for panels and rules, **2 px** for controls |

Nothing is ever below 14 px. WCAG 2.2 AA asks for a 24 px target, and 32 px clears it; touch screens
(`@media (pointer: coarse)`) keep the Mansus 44 px. The design target is a 1280 to 1440 px desktop.
Phones (360 and 390 wide) work with no horizontal scroll, but nothing is designed for them first.

## Tokens

Every screen uses these custom properties from `styles/base.css`. A screen stylesheet never hardcodes
a colour, a font, a size from this list or a dither image.

```css
:root {
  --paper: #e4e2db;
  --ink: #141414;

  --font-display: "Anybody", system-ui, sans-serif;
  --font-text: "Atkinson Hyperlegible Next", system-ui, sans-serif;
  --font-code: "Atkinson Hyperlegible Mono", ui-monospace, monospace;

  --fs-ui: 14px;      /* line-height: 20px */
  --fs-body: 15px;    /* line-height: 1.5 */
  --fs-h2: 16px;      /* weight 700 */
  --fs-title: 32px;   /* Anybody, font-stretch 50%, weight 900, line-height 1 */
  --fs-figure: 40px;  /* Anybody, the dashboard's numbers */

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;

  --control-h: 32px;  /* 44px under (pointer: coarse) */
  --row-h: 36px;      /* 44px under (pointer: coarse) */
  --sidebar-w: 224px;

  --rule: 1px solid var(--ink);
  --rule-dotted: 1px dotted var(--ink);
  --control-border: 2px solid var(--ink);
  --shadow: 4px 4px 0 var(--ink);

  /* Tones: the only greys. 2 px cells, real squares, as background-image tiles. */
  --tone-checker: …;     /* 50%: 2 px checkerboard */
  --tone-crosshatch: …;  /* an X lattice of 1 px diagonals on a 4 px step */
  --tone-hatch: …;       /* one set of 1 px diagonals on a 4 px step, rising left to right */
  --tone-sparse: …;      /* 25%: a 2 px square on a 4 px step */
  --tone-faint: …;       /* 6%: a 2 px square on an 8 px step, for "off" and for the ghost */
}
```

Breakpoints, the same everywhere:

- **640 px:** below it, tables stack into one block per row, and columns become `label value` lines.
- **940 px:** below it, the sidebar becomes a top bar with a Menu button.
- **1100 px:** above it, paired sections such as the dashboard's two tables sit side by side.

### Status tones

Charts and the run timeline fill a bar by its status. Each tone echoes its sign, so the legend and the
bar say the same thing:

| Status | Sign | Fill |
| --- | --- | --- |
| `succeeded` | solid square | solid ink |
| `running` | checkerboard | `--tone-checker` |
| `failed` | X | `--tone-crosshatch` |
| `cancelled` | box with a diagonal | `--tone-hatch` |
| `interrupted` | box with a diamond | `--tone-sparse` |
| `waiting_retry` | box with dots | no fill, 1 px dashed outline |
| `pending`, `skipped` | empty box, triangle | no bar |

Every bar that is not solid gets a 1 px ink outline, so even a light tone has an edge. In SVG the tones
are `<pattern>`s with `shape-rendering="crispEdges"`, made once per chart by the shared helper (see
Components). Every chart has a legend, and every legend entry is a swatch, a sign and a word.

## The shell

```
┌──────────────┬────────────────────────────────────────────────────────────┐
│ bashreactor  │ Runs / word-report / 20261105T201258Z-f1549287             │
│              │ word-report                          [Retry] [Download] [⋯] │
│ ▦ Dashboard  │ 20261105T201258Z-f1549287  ✕ failed                        │
│ ▶ Runs       │ Started 3 min ago · Took 1 m 12 s · Steps 2 / 4 · v3       │
│ ⋎ Pipelines  │ ─────────────────────────────────────────────────────────── │
│ ▤ Blocks     │ …                                                          │
│              │                                                            │
│ ⚌ Settings   │                                                            │
│ admin [admin]│                                                            │
│ Sign out     │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- **Sidebar** (940 px and up): `--sidebar-w` wide and the full height of the viewport (sticky), on
  paper, with a 1 px ink rule on its right and 16 px padding.
  - **Top:** the wordmark, linking to the Dashboard. It keeps today's face and weight (Anybody 860)
    and is sized to fit the 192 px column on one line: about 22 px at `font-stretch: 112%`. Adjust the
    stretch before the size, and never go below 22 px.
  - **Nav:** Dashboard, Runs, Pipelines, Blocks. Each item is `--control-h` tall: a 14 px glyph, an
    8 px gap, then the label in 14 px weight 600. The current item is inverted (ink background, paper
    text) and carries `aria-current="page"`; hovering an item draws a 3 px ink bar on its left.
  - **Bottom:** Settings (same style), then who is signed in: the token's name and a stamp for its
    access (`admin`, `write`, `read`), and a text button, Sign out.
- **Top bar** (below 940 px): the wordmark on the left and a Menu button on the right. The menu opens
  the same items as a panel under the bar.
- **Main area:** 24 px by 32 px of padding (16 px below 940 px). There is no footer; the font licence
  link lives in Settings.
- **Nav glyphs:** 7×7 bitmaps, drawn like the signs at 2 px per cell:

```
Dashboard   Runs        Pipelines   Blocks      Settings
###.###     #......     ##...##     #####..     .#.....
###.###     ###....     ##...##     #...##.     #######
###.###     #####..     .#...#.     #....##     .#.....
.......     #######     .#####.     #.....#     .......
###.###     #####..     ...#...     #.....#     ....#..
###.###     ###....     ..###..     #.....#     #######
###.###     #......     ..###..     #######     ....#..
```

## Components

These live in `src/client/ui.ts` (with `el`, `sign` and the error box in `dom.ts`), styled in
`styles/base.css` and `styles/shell.css`. Every screen builds itself out of them. A screen's own
stylesheet holds only that screen's layout: it never restyles a component, and it never invents one
that is already here.

- **Page header.** The breadcrumb comes first; its links are 14 px, separated by ` / `, and the last
  item is the current page (not a link; mono when it is an id). Then the title (one per screen) with
  the page's actions right-aligned on the same row. Then an optional row holding the id in mono and
  the status stamp. Then an optional meta line: 14 px, items separated by ` · `, each a `Label value`
  pair with the label in weight 700. A 1 px rule closes the header, 16 px below it.
- **Button.** `--control-h` tall, 0 12 px of padding, `--control-border`, 14 px weight 700, on paper.
  Hover and press invert it. The primary variant is ink with paper text, and its hover inverts back.
  There is at most one primary per header. A destructive action (Cancel, Delete, Revoke) is never
  primary, and Delete and Revoke always ask first in a dialog. A disabled button follows "off, not
  grey", with its reason in a 14 px line beside it. A link that looks like a button is an `<a>`.
- **Field.** Input and select are `--control-h` tall, with `--control-border` and 0 8 px of padding. A
  select draws the pixel caret (`--arrow`). The label sits above in 14 px weight 700, and help sits
  below in 14 px. The checkbox is drawn 1-bit: a 16 px box with an inset ink square, on a hit area of
  `--control-h`.
- **Segmented control.** A radio group drawn as joined buttons that share their borders; the chosen
  one is ink. Used for time windows and attempt switchers. Arrow keys move inside it.
- **Filter chip.** A toggle button (`aria-pressed`) drawn like a stamp, 28 px tall (44 px when the
  pointer is coarse): the status's sign and word, outlined when off, ink when on. Used for multi-status
  filters.
- **Tabs.** A `tablist` on a 1 px ink rule. Each tab is 36 px tall with 0 12 px of padding, 14 px
  weight 700. The selected tab has a 3 px ink bar along its bottom edge and `aria-selected="true"`.
  Left, Right, Home and End move between tabs. The selected tab lives in the URL (`?tab=`), so a
  reload and the back button keep it.
- **Stamp.** 22 px tall, 0 6 px of padding, 14 px weight 700. A status stamp is ink, holding its sign
  (14 px, drawn in paper) and its word. A type stamp is outlined in 1 px.
- **Sign.** 14 px, at 2 px per cell. A sign never appears without its word nearby, except inside a
  run-history strip, where every sign has a `title` and an accessible name.
- **Table.** The workhorse.
  - Header cells: 14 px weight 700 on a 1 px ink rule.
  - Body rows: `--row-h` tall, 0 12 px of padding, a 1 px dotted rule between rows.
  - Numbers are right-aligned with `tabular-nums`. Ids, versions and hashes are mono.
  - A row that opens something has one real link in its first useful cell, stretched over the whole
    row (`position: relative` on the row and an `::after` inset of 0 on the link). Hovering the row
    draws a 3 px ink bar on its left; keyboard focus shows the focus ring on the link.
  - An empty table is one row: a sentence and at most one action.
  - Below 640 px every row becomes a block: the first cell on top, then `label value` lines read from
    each cell's `data-label`.
- **Runs table.** The one way a list of runs is shown, used by Runs, the Dashboard and a pipeline's
  Runs tab. It takes its columns from this set:
  - Status: the stamp.
  - Run: the id in mono, as the link.
  - Pipeline: a link to the pipeline's page.
  - Version: `v3`, or `—`.
  - Started: relative time, with the exact time in `title`.
  - Duration: counts up while the run is running.
  - Steps: `succeeded / total`, plus ` · 1 failed` when steps failed.

  It updates rows in place (keyed by run id), so a poll never drops focus or the scroll position.
- **Run-history strip.** The last N runs of something, as signs in a row with the newest on the
  right. Each sign links to its run and carries a `title` such as
  `20261105T201258Z-f1549287 · failed · 3 min ago`.
- **Alarm.** For something that needs an answer now, such as a failed run or a disk running out. It has
  `--control-border`, `--shadow` and 10 px by 12 px of padding, on one line where it fits: a sign, a
  14 px sentence whose first words are weight 700, then its actions on the right. Use at most one per
  screen.
- **Meter.** A 160 px × 10 px bar with a 1 px ink frame, filled with solid ink up to its fraction,
  with the numbers in 14 px beside it.
- **Dialog.** A native `<dialog>`, at most 560 px wide, with `--control-border`, a `6px 6px 0` ink
  shadow and 20 px of padding. The title is 16 px weight 700. One help line at most, and the actions
  are right-aligned with the primary last. The backdrop is `--tone-sparse` over the page, never a
  translucent colour.
- **Empty state.** One 15 px sentence and at most one action. No illustrations.
- **Charts.** Inline SVG with `shape-rendering="crispEdges"`, filled with the status tones.
  - Axes: 1 px ink lines with 14 px labels, and three y ticks at most.
  - Each bar is a `<g>` with a `<title>`, for example `5 Nov, 14:00 · 3 succeeded, 1 failed`.
  - Each chart also renders its numbers as a visually hidden table, for screen readers.
  - No animation, no gradients and no tooltips beyond `<title>`.
- **Formatters,** one of each, used everywhere:
  - **Relative time:** `just now` under 10 s, then `45 s ago`, `3 min ago`, `2 h ago`, `4 d ago`, and a
    date (`5 Nov`) beyond 7 days.
  - **Exact time:** `Intl.DateTimeFormat` in the reader's locale with day, short month, year, hour,
    minute and second, e.g. `5 Nov 2026, 21:12:58`.
  - **Duration:** `<1 s`, `12 s`, `4 m 05 s`, `1 h 02 m`, `2 d 03 h`. Never `0 s`.
  - **Bytes:** `834 B`, `1.6 KB`, `12 MB`, `1.2 GB`, in base 1024, with one decimal under 10.
  - **Counts:** `Intl.NumberFormat`.

## Routes

Everything is under `/app`. Every route that has a state worth sharing keeps it in the query string.

| Path | Screen |
| --- | --- |
| `/` | Dashboard. `?window=24h\|7d\|30d` |
| `/runs` | Runs. `?status=failed,cancelled&pipeline=word-report&window=24h\|7d\|30d\|all` |
| `/runs/:id` | One run. `?step=<id>&attempt=<n>&tab=logs\|steps\|graph\|io\|files` |
| `/pipelines` | Pipelines |
| `/pipelines/:name` | One pipeline. `?version=<n>&tab=runs\|definition\|versions\|inputs` |
| `/pipelines/:name/edit` | The editor, on a stored pipeline. `?version=<n>` |
| `/pipelines-new` | The editor, on a new pipeline (`new` is a legal pipeline name, so it cannot be `/pipelines/new`) |
| `/blocks` | Blocks |
| `/blocks/:name` | One block. `?version=<n>&tab=contract\|source\|versions` |
| `/blocks/:name/edit` | The writer, for a new version of a block. `?version=<n>` to start from |
| `/blocks-new` | The writer, for a new block |
| `/settings` | Settings |

The old addresses redirect, so links and bookmarks keep working: `/pipeline` goes to
`/pipelines-new`, and `/pipeline/:name/:version` goes to `/pipelines/:name/edit?version=:version`.

## Screens

### Dashboard (`/`)

What is happening, and what needs you.

- **Header:** the title "Dashboard". On the right, a segmented control for 24 h, 7 d and 30 d (default
  24 h). Production keeps runs 30 days.
- **Alarm,** only when `GET /v1/disk` says `low`: `Disk almost full · 3.1 GB free of 40 GB.` with a link
  to Settings.
- **Counts:** four tiles in a row (2 × 2 below 640 px): running, succeeded, failed and cancelled.
  - Each tile has a 1 px border and 12 px by 16 px of padding: the sign and word on top (14 px weight
    700), then the number in Anybody at `--fs-figure`.
  - Running counts every run that is running now, whatever its age; the other three count runs created
    in the window.
  - A tile is a link to the Runs list with that filter: `/runs?status=failed&window=24h`, and
    `/runs?status=running` for running.
- **Activity:** runs created per hour (24 h) or per day (7 d, 30 d), as one stacked bar per bucket.
  - Bars are stacked from the baseline up: failed, cancelled, running, succeeded.
  - It is 160 px tall and as wide as the main area, with a legend under it.
  - An empty bucket has no bar, and the axis says so.
- **Running now** and **Failed:** two runs tables, side by side above 1100 px.
  - Running now: Status, Run, Pipeline, Started, Duration, Steps.
  - Failed: Run, Pipeline, Started, Steps, and a Retry button per row, for tokens that can write.
    Retry posts `/v1/runs/:id/retry`, then opens the run.
  - Each table shows at most 10 rows, then a `View all` link to the filtered Runs list.
  - Empty states: "Nothing is running." and "No failed runs in the last 24 h."
- **Disk:** at the bottom, one line with a meter: `Disk 42% used · 380 GB free of 907 GB · runs 1.2 GB`.
- **Data:**
  - `GET /v1/runs?since=<window start>&limit=500`, following `X-Next-Cursor` to the end;
  - `GET /v1/runs?status=running&limit=50`;
  - `GET /v1/disk`.
- **Refresh:** every 5 s while anything is running, otherwise every 15 s. Nothing is read while the tab
  is hidden, and everything is read again the moment it is shown.
- **No runs at all:** "No runs yet." with a link to Pipelines.

### Runs (`/runs`)

Every run, newest first, filterable.

- **Header:** the title "Runs".
- **Filter bar** under the header, on one row where it fits:
  - status chips (running, succeeded, failed, cancelled);
  - a pipeline select ("All pipelines", then every name from `GET /v1/pipelines`);
  - a window segmented control (24 h, 7 d, 30 d, All; default All);
  - at the right, the count shown so far ("37 runs", or "50+ runs" while there are more pages).

  Every change rewrites the URL with `history.replaceState` and reloads the list. When any filter is
  set, a "Clear filters" button appears.
- **Table:** the runs table with Status, Run, Pipeline, Version, Started, Duration and Steps.
  - 50 rows, then a `Load more` button while the API sends `X-Next-Cursor`.
  - Rows that change status while you watch flash once.
- **Data:** `GET /v1/runs?limit=50` plus the filters (`status`, `pipeline`, and `since` worked out from
  the window).
- **Refresh:** the first page again every second while any listed run is running, otherwise every
  15 s, merged into the rows already on screen. Nothing is read while the tab is hidden.
- **Empty:** "No runs match these filters." with Clear filters, or, with no filters, "No runs yet."
  with a link to Pipelines.

### One run (`/runs/:id`)

- **Header:**
  - Breadcrumb: `Runs / <pipeline> / <run id>`.
  - Title: the pipeline's name.
  - Under it: the run id in mono, the status stamp, and a `cancel requested` stamp when that is set.
  - Meta: Started (relative, exact in `title`), Finished (once finished), Duration (counting while
    running), Steps `3 / 4`, and Version `v3`, linked to the pipeline page at that version (left out
    when `pipeline_version` is null).
  - Actions on the right, only those that can work for this run, this claim and this token (the
    BASHR-32 rules):
    - Cancel, while running;
    - Retry, when failed or cancelled (primary);
    - Resume, while running with no live claim;
    - Download, the run as `.tar.gz`, always;
    - Delete, once finished, after a dialog.
- **Alarm,** when the run failed: the failed step's sign, `check failed · block_fatal: check-corpus: 50
  lines, need at least 100`, and the actions Retry and Show log. Show log selects that step and the
  Logs tab.
- **Timeline,** in place of the old step cards. It is a panel with a 1 px border.
  - **Left column** (200 px): one row per step in declaration order, each the step's sign and its id
    in 14 px weight 700, with `×3` after the id when it has had more than one attempt.
  - **Track:** a time axis on top with 14 px labels at round steps (1 s, 5 s, 10 s, 30 s, 1 m, 5 m,
    15 m, 30 m, 1 h, 3 h, 6 h, 12 h, 1 d), from the run's `created_at` to its `finished_at`, or to now
    while it runs.
  - **Bars:** one per attempt, from `started_at` to `finished_at` (or now), 12 px tall, filled by the
    attempt's status tone.
  - **Waits:** a step in `waiting_retry` shows a dashed outline from the end of its last attempt to
    `next_attempt_at`.
  - **Now:** while the run is live, a 1 px ink line marks now.
  - Rows are 28 px tall, and the panel shows at most 10 before it scrolls; the axis stays on top.
  - **Selecting:** each row is a button in a roving-tabindex group (Up, Down, Home, End). Clicking or
    pressing Enter selects that step: its label cell is inverted, and it lands in the URL (`?step=`).
- **Tabs** under the timeline (`?tab=`, default `logs`):
  - **Logs:** a toolbar with the step id, a segmented control of its attempts (each with its sign),
    Follow (`aria-pressed`), the bytes read so far, and Download log. Below it, the log in mono 14 px
    with a line-number gutter, at least 320 px tall and filling the viewport. Follow chases the live
    edge, and scrolling up drops it (today's behaviour, from `logs.ts`). An attempt with no output says
    "No output yet." while running, or "This attempt wrote nothing."
  - **Steps:** a table of Step (id, and the display name under it when they differ), Block (mono:
    `name@version` or `./file.sh`), Status, Attempts, Started, Duration, and Outputs (the names,
    mono). A row selects the step and opens Logs.
  - **Graph:** the pipeline graph from `graph.ts`, read-only, each node showing its step's sign and
    status. A node selects the step and opens Logs. The graph keeps its keyboard walking.
  - **Inputs & outputs:** two tables of name and value: the run's inputs, then its outputs. Values are
    mono, and a `json` value is printed compactly. A `file` output is a download link. Before the run
    succeeds: "Outputs appear when the run succeeds."
  - **Files:** `GET /v1/runs/:id/files` as a table of path (mono), size and download, with
    "Download the whole run" (`.tar.gz`) above it.
- **Data:** `GET /v1/runs/:id`, read every second while the run is running and not again once it has
  finished. Logs come from `GET /v1/runs/:id/logs/:step/:attempt?offset=`.

### Pipelines (`/pipelines`)

- **Header:** the title "Pipelines". On the right, New pipeline (primary, write tokens only).
- **Table:**
  - Name (the link, weight 700).
  - Description (one line, cut with an ellipsis).
  - Latest (`v3`).
  - Last run (a stamp and a relative time, or `never`).
  - Recent runs (a run-history strip of the last 10).
- **Data:**
  - `GET /v1/pipelines` for the rows;
  - per row, `GET /v1/pipelines/:name/:latest` for the description, and
    `GET /v1/runs?pipeline=:name&limit=10` for the last run and the strip.

  The per-row reads run at most 4 at a time, and each cell fills in when its answer arrives.
- **Empty:** "No pipelines stored yet." with New pipeline.

### One pipeline (`/pipelines/:name`)

- **Header:**
  - Breadcrumb: `Pipelines / <name>`.
  - Title: the name.
  - On the right: a version select (`v3 (latest)`, `v2`, …), then Run (primary) and Edit, for write
    tokens.
  - The description as a 15 px line under the title.
  - Meta: Version `v3 of 3`, Stored, and sha256 (mono, first 12 characters).
- **Run:** opens the Start dialog (`start-run.ts`): one typed field per pipeline input, with its
  default filled in. It posts `{pipeline, version, inputs}`, then opens the new run.
- **Tabs** (`?tab=`, default `runs`):
  - **Runs:** a duration chart, then the runs table (Status, Run, Version, Started, Duration, Steps)
    from `GET /v1/runs?pipeline=:name&limit=50`, with Load more.
    - The chart shows the last 30 runs, one bar each, newest on the right.
    - A bar's height is the run's duration and its fill is the run's status tone.
    - The y axis is durations, and clicking a bar opens that run.
  - **Definition:** the selected version, read-only. The graph (`graph.ts`) and the YAML (painted, with
    line numbers) sit side by side above 1100 px, and stacked below.
  - **Versions:** a table of Version (links to the Definition tab at that version), Stored, and sha256
    (mono, 12 characters), with "Edit from this version" per row for write tokens.
  - **Inputs:** the pipeline's contract: inputs (name, type stamp, default or `required`,
    description), then outputs (name, and the expression in mono).

### Editor (`/pipelines/:name/edit`, `/pipelines-new`)

The model does not change:

- the YAML text is the state;
- the graph is drawn from it and never stored;
- a parse error shows the last good graph as a ghost (`--tone-faint`, inert) while the text stays
  broken and honest;
- a graph edit is a text edit on the lines the parser recorded.

The layout does change:

- **Breadcrumb:** `Pipelines / <name> / Edit`, or `Pipelines / New`.
- **Toolbar,** one sticky row at the top of the main area, closed by a 1 px rule:
  - the pipeline's name (16 px weight 700) and a `from v3` type stamp;
  - an `unsaved` status stamp while the text differs from what was opened;
  - then, right-aligned, Validate, Save version and Run (primary).

  A disabled action says why right beside the buttons, for example "Fix 2 problems to save." There is
  no page title in Anybody here: the toolbar is the header.
- **Panes:**
  - Above 1100 px, the YAML pane fills the left half, at the full height of the viewport. The right
    half holds the graph on top (about 55%) and the step inspector under it.
  - The problems list sits under the YAML. Each problem is a button that moves the caret to its line.
  - Below 1100 px everything stacks: graph, YAML, inspector, problems.
- **Kept as is:** Add step, Undo, the inspector's wiring, walking the graph with the keyboard, drafts,
  the leave guard, and the version select.
- **Removed:** the "Stored pipeline" open-by-name box. Pipelines are opened from the Pipelines list.

### Blocks (`/blocks`)

- **Header:** the title "Blocks". On the right, New block (primary, write tokens only).
- **Table:** Name (the link), Description, Runtime (a type stamp: `bash`, `uv` or `bun`), Latest
  (`v2`) and Versions (a count).
- **Data:** `GET /v1/blocks` for the rows. Per row, the latest version's content
  (`GET /v1/blocks/:name/:version/content`), parsed with the header parser for the description and
  the runtime. At most 4 reads run at a time.
- **Empty:** "No blocks in the library yet." with New block.

### One block (`/blocks/:name`)

- **Header:**
  - Breadcrumb: `Blocks / <name>`.
  - Title: the name, followed by the runtime stamp.
  - On the right: a version select, then New version (write tokens), which opens the writer from the
    selected version.
  - The description as a 15 px line under the title.
- **Header problems:** problems found in the block's header are listed in an alarm above the tabs.
- **Tabs** (`?tab=`, default `contract`):
  - **Contract:** inputs (name in mono, type stamp, default or `required`, description), then outputs
    (name, type, description).
  - **Source:** the file, read-only, in mono 14 px with line numbers.
  - **Versions:** Version, Stored, sha256 (12 characters) and Size.

### Writer (`/blocks/:name/edit`, `/blocks-new`)

- **Toolbar,** as in the editor: the block's name (or "New block"), an `unsaved` stamp, and Publish
  version (primary).
- **Panes:** above 1100 px, the source on the left, and on the right, "What this file declares": the
  contract parsed live from the header, with its problems.
- **Kept as is:** drafts and their behaviour.

### Settings (`/settings`)

The title "Settings", then four sections, each with a 16 px weight 700 heading and separated by a 1 px
rule:

- **You:** the token's name, its access as a stamp (`admin`, `write` or `read`), and Sign out.
- **Server:** the version, the API URL and the MCP URL (`<origin>/mcp`), both mono, and "Fonts and
  their licence" (`/app/OFL.txt`).
- **Disk:** the meter, used, free and total, the runs' share, and the data path in mono, from
  `GET /v1/disk`. When it reports `low`, this section is an alarm.
- **Tokens** (admin only; other tokens do not see the section at all):
  - A table of Name, Access (stamp), Created and Last used (`never` when null), with Revoke per row.
    Revoke asks in a dialog, then calls `DELETE /v1/tokens/:id`.
  - New token opens a dialog with a name field and an access choice (read or write), then
    `POST /v1/tokens`.
  - The answer shows the secret once, in a mono box with a Copy button, and says "This is the only
    time it is shown."

### Sign-in

There is no sidebar here. One column at most 420 px wide, 15vh from the top:

- the wordmark;
- one line: "Sign in with the admin token or an agent token.";
- Server URL;
- Token;
- Remember on this device;
- Sign in (primary).

Every message the gate says today about a refused, missing or unchecked token stays, word for word.

## Copy

- The UI speaks in labels, numbers and statuses. A sentence appears only in an empty state, in an
  error, beside a disabled control to say why it is off, and as one help line in a dialog.
- Everything is in sentence case: "Save version", "New pipeline".
- The UI never explains how it is built. No "derived from the YAML", no "run.json", no "byte offset",
  and no "the API has no route for".
- An error shows its code in mono and the server's message, from `errorBox` in `dom.ts`.
- The words are the glossary's: run, step, attempt, block, pipeline, version, library. Statuses are the
  spec's words, verbatim.

## Accessibility

- A 3 px ink focus ring, offset 2 px, on everything focusable. A skip link to the main area.
- Keyboard everywhere: tabs, segmented controls, the timeline, the graph, dialogs (native, with focus
  returned to the opener) and the sidebar menu.
- Targets: 32 px with a mouse, 44 px when the pointer is coarse.
- Tables are real tables; their stacked phone layout comes from `data-label`, not from a second
  layout.
- Status changes are announced in the one status region (`#announce`). The log is not a live region.
- No horizontal scroll at 360, 390, 1280 and 1440 wide. Long lines scroll inside their pane.

## Deliberately not done

- No dark mode. An inverted 1-bit theme is possible later, because nothing hardcodes the two inks.
- No sorting, no bulk actions, no search and no keyboard shortcuts.
- No "used by" on a block. A library reference always names a version, so a new block version cannot
  break a pipeline, and finding the users would cost one read per pipeline.
- No charts beyond the dashboard's activity and a pipeline's durations.
