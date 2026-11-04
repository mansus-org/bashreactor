# Bashreactor, design notes

Why the mockup looks the way it does, and what carries over to `apps/web/` (BASHR-8). Files:
`mockup/*.html`, `mockup/style.css`, `mockup/*.js`. Screenshots at 1440 and 390 wide are in
`mockup/screenshots/`. The interface is built in the Mansus 1-bit language: paper `#e4e2db`, ink
`#141414`, grey only as dither, Anybody for display at 28 px and up, Atkinson Hyperlegible Next for
reading, Atkinson Hyperlegible Mono for code, all self-hosted. The full reasoning is in
`mansus-org/revolution/design/README.md` and `mansus-org/myself/design/README.md`.

Design read: a working tool for people who run hours-long bash pipelines and want to see, fix and
watch them without a second source of truth. Dials: ENERGY 2 / RHYTHM 2 / MOTION 1.

## The idea

A pipeline is one YAML document, a step is one bash file, and a run is one directory. The mockup
shows the three things a person does with those three things: edit the pipeline, watch a run, browse
the blocks. Nothing on the screens stores a second copy of the pipeline, a block or a run; the
editor derives its graph from the YAML, the library reads a block's contract from its front matter,
and the run view reads the shape of `run.json` from the spec, so the screens are built against the
data the API will return and not against a parallel schema.

## Decisions, one line each

- **Palette:** paper `#e4e2db`, ink `#141414` (14.2:1). Grey is only ever dither, drawn as real
  square pixels on a sub-grid, so it stays 1-bit at any zoom.
- **Typeface:** Anybody (width 50, weight 900) for display only, 28 px and up; everything people
  read is Atkinson Hyperlegible Next, and code is Atkinson Hyperlegible Mono. All three are
  self-hosted in `mockup/fonts/`.
- **Entry page:** one line says what Bashreactor is, then the three screens and the state of the
  project, in the same inks and ruled rows, not a landing page.
- **The editor's state is the YAML text.** Typing changes the text; every control on the graph side
  computes a new text and re-parses. There is no document model beside the text, so the graph and
  the YAML cannot drift.
- **The graph is derived, never stored.** It is a view of the text: parse the YAML, resolve
  references, lay out dependencies. A click on a node jumps to its lines in the YAML because the
  parser keeps every key's line range.
- **Ghost on parse error:** when the YAML does not parse, the graph keeps showing the last version
  that did, dithered and inert, with a note pointing at the broken line. It keeps the shape of the
  document visible while the person fixes it, and never pretends the broken text is valid.
- **Block contract from the file:** the library and the inspector read a block's inputs and outputs
  by parsing its comment header, never from a sidecar list, so what the screen says is what the file
  declares.
- **One 7×7 sign per state:** run and step states (`pending`, `running`, `waiting_retry`,
  `succeeded`, `failed`, `skipped`, `cancelled`) each have a shape as well as a word, drawn cell by
  cell as crisp SVG so a row reads at a glance in two inks.
- **The run view streams.** It moves steps through the spec's statuses on a timer and plays each
  attempt's log, the way a reader would follow byte offsets from the API. Follow chases the live
  edge, scrolling up to read drops it.
- **Controls are real controls:** steps are buttons, the graph is walkable with arrow keys, dialogs
  are native `<dialog>`, checkboxes are drawn 1-bit with a 44 px hit area, and every link and button
  is a 44 px target.
- **Elevation and motion:** only dialogs and the alarm get the offset shadow, because they need an
  answer now. The one motion is an e-ink flash when something changes; nothing loops, and it is off
  under `prefers-reduced-motion`.

## Why the editor keeps the YAML as the single source of truth

The pipeline YAML is the document a person owns, versions and shares, the same file the engine
snapshots into a run. If the editor stored steps and wires in its own objects and wrote YAML back,
the two would drift the first time a person edits the file by hand or a tool reformats it. Keeping
the text as the state and parsing it on every change means the graph is always what the file says,
and a graph edit is a text edit with a line range, so comments and formatting a person typed are
never eaten.

## Why the graph is derived

Because it is not a second document, it is a reading of one. Deriving it means there is no
"save the graph" step and no reconciliation; the only truth is the text. The cost is that a text
that does not parse cannot have a graph, which is exactly where the ghost comes in: the editor holds
the last good parse on screen, dithered to say "this is what it meant", while the text stays broken
and honest above it.

## What the ghost-on-parse-error is for

A person typing in the YAML pane will often be between two valid documents. A screen that blanks
the graph the moment line 14 has one wrong indent throws away the one thing that shows the shape of
the pipeline. The ghost keeps that shape, clearly stale and unclickable, so the person can see where
they were and what they are moving toward while the problem list points at the line to fix. It is a
reading aid, not a hidden truth: the text is always shown, and the ghost is marked as stale.

## Accessibility

- The skip link, the 3 px ink focus ring and 44 px targets follow the Mansus rules.
- The graph is a roving-tabindex set of real buttons: Up and Down walk steps, Right and Left follow
  a wire, Home and End reach the ends. The wires are `aria-hidden` SVG.
- State changes are announced in a status region; the log does not use `role=log`, so it is not read
  aloud line by line, only the step's state change is.
- Checked at 360, 390 and 1440 wide, no horizontal scroll; long lines scroll inside their pane.

## Deliberately not done

- The mockup does not run anything. Logs are replayed fixtures, and the run simulator plays state
  transitions, because the engine does not exist yet.
- Block publishing in the mockup stores the new source in `localStorage`; it computes the SHA-256
  the store will use but does not run or index anything.
- `published` and `note` on block versions are mockup store metadata; the store task (BASHR-4) owns
  the real record and the real hashing.
- The web app (`apps/web/`) is not built yet. This mockup is the design the app will implement
  against the API, not a release of it.
