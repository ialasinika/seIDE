# `shell/web/` — the seIDE board UI

This directory is the entire front end. It is served straight off disk by
`node shell/main.mjs serve` on `http://127.0.0.1:<port>/`, with no build step
and no dependencies: the browser loads these ES modules as written.

```
index.html    the single page; no inline logic
style.css     the whole look
rpc.mjs       POST /rpc + GET /events client (SSE framing, RpcError)
board.mjs     the board document, viewport, selection and mutations
history.mjs   the undo ring: document snapshots, coalescing, redo branch
cards.mjs     one renderer per card kind + the pure helpers
classic.mjs   the same cards as a code area, tabs and a sidebar (pure)
main.mjs      bootstrap: gestures, command line, log, dirty state
selftest.mjs  node shell/web/selftest.mjs -- no DOM, no network
```

---

## The board paradigm

There are **no tabs and no file tree**. The main surface is one persistent,
pannable, zoomable 2-D space, and everything you work on is a **card** placed at
a point in it. Opening a file does not add a tab; it puts a card somewhere on
the plane. Closing a card does not lose the file; it removes a rectangle.

There is one second arrangement, and it is a *view*: `mode classic` lays the same
cards out as a code area, a tab strip and a sidebar (see
[the classic view](#the-same-cards-as-a-code-area-mode-classic)). It creates no
card, moves no card, and saves nothing — the tabs are the editor cards, in board
order. The board is the document; the view is what you can do with it.

The layout *is* project data. It lives in `.seide/board.json` next to your
sources, so the IDE remembers a spatial arrangement — what you had open, where
you put it, what was linked to what — rather than a tab history. Two people on
the same repository open the same board.

This directory is a **reference implementation** of one view. The schema, the
path and the ids are all decided here (`board.mjs` owns `BOARD_PATH`, the
`isValidCard`/`normaliseDocument` rules and `makeId`); the kernel is handed the
document and stores it without reading it, so another client can keep a
different document at a different path, or draw this one another way, without
touching `core/` — [`docs/VIEWS.md`](../../docs/VIEWS.md).

The command line at the bottom is the only place commands live. It is not a
modal palette and not a fuzzy finder popup: it stays where it is, it acts on the
currently focused card, and every message it has for you is appended to the log
line above it. **seIDE has no dialogs**, so nothing ever covers the board.

### Card kinds (registered, not hard-coded)

| kind | what it holds | stored fields |
| --- | --- | --- |
| `editor` | a file, with keyword colouring | `file` |
| `runner` | one command and its output | `cmd`, `cwd`, `run_id` |
| `note` | free text, part of the board | `text` |
| `files` | a workspace listing, filtered | `filter` |
| `project` | the workspace as one project: the tree plus what is open | `filter` |
| `search` | a literal find across the workspace, with a row per hit | `query`, `glob`, `caseSensitive` |
| `sheet` | structured data: typed cells, not text | `title`, `doc` |
| `frame` | a labelled region that moves the cards standing inside it | `title` |

A kind exists because it was registered, and registering is one call at the end
of `cards.mjs`:

```js
registerCardKind({ kind, title, create, describe, render });
```

That is a **fork-time hook, not a plugin system** (there is no loading, no
discovery, no manifest and no sandbox): the call runs while this module graph is
evaluated. `renderCard` dispatches through the registry, so an unregistered kind
cannot crash the UI — it renders as a placeholder that names the kinds this
build does know and points at `cards.mjs`. The kernel stores unknown kinds and
their fields verbatim, so nothing is destroyed in the meantime.

`shell/web/selftest.mjs` covers the hook itself (including that a probe kind
survives a save/load round trip). The full contract, and `sheet` as a worked
example, are in [`docs/SURFACES.md`](../../docs/SURFACES.md).

### Links

Two cards can be linked (`link c1 c3 runs`), and the connection is drawn as a
straight line between their facing edges. Links are stored in the same
document, so a board can record *why* things are next to each other.

---

## Gestures

| gesture | effect |
| --- | --- |
| drag empty space | pan the board |
| wheel over a card's own contents | scroll the card (an editor, a sheet, a runner's output) |
| wheel / shift+wheel elsewhere | pan |
| ctrl/⌘ + wheel | zoom about the cursor |
| drag a card title | move the card |
| drag a card's bottom-right corner | resize the card |
| click a card | focus it; it comes to the front |
| ctrl/⌘ + click a card | add it to the selection, or take it out again |
| shift + click a card | the same, for the hand that expects shift to extend |
| ctrl/⌘ + A | select every card (and, in a text field, all its text — the field wins) |
| shift + drag empty space | rubber band: select every card the band touches (add ctrl to keep what was selected) |
| drag a selected card's title | move the whole selection by one delta |
| Delete / Backspace, with a selection | remove the selected cards and their links, in one undo step |
| double-click empty space | drop a new note there |
| `:` | focus the command line |
| ctrl/⌘ + S | save the board |
| ctrl/⌘ + Z | take back the last board edit |
| ctrl/⌘ + shift + Z, or ctrl/⌘ + Y | put it back |

Zoom is clamped to 20 %–400 %, and a card is clamped to 120×80 px so a card can
never be resized into something you cannot grab again.

The selection is a **set** of card ids with one *primary* member. `selectedId`
still names the primary, so every verb written when the selection was a single
card keeps working; the primary is the card the HUD describes and the one a
command with no argument acts on. Clicking a selected card without a modifier
keeps the set and only makes that card the leader — the collapse to a single
card happens on mouse-up, if the pointer never moved, which is what makes
"drag one of three" and "click one of three" the same gesture at the start. The
rubber band is drawn inside `#stage`, so it is world-space and zooms with the
board for free; it uses intersection, not containment, because requiring a whole
card inside the band makes the gesture useless on a dense board. A band with a
non-finite edge selects nothing rather than everything.

### Command line

```
open <path>              open a file in a new editor card
note <text>              drop a note card
sheet [title]            drop a structured-data card (typed cells, not text)
run <cmd>                start a command in a runner card
files [glob]             open the file list card
project [glob]           open the project panel (the workspace as one project)
find <text>              search the workspace (or re-point the open search card)
link <from> <to> [label] connect two cards
unlink <linkId>          remove a connection
zoom <n> | in | out | reset
focus <id>               select and centre a card
select <id...> | all | none  replace the selection with these cards
group [title]            frame the selection (or drop an empty frame)
ungroup [id...]          remove frames; the cards they held stay
delete <id>              remove a card (with no id: everything selected)
save [force]             write .seide/board.json
undo                     take back the last board edit (Ctrl+Z)
redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)
help                     list the commands
clear                    empty the log
```

An unknown command prints one line in the log and moves on. Nothing is modal,
nothing steals focus.

---

## Files, and what deleting each one costs

Each file is meant to be independently deletable; the consequence is stated so
the trade-off is explicit rather than discovered.

| file | delete it and… |
| --- | --- |
| `rpc.mjs` | nothing can reach the kernel: the board still renders and pans, but no file is read, nothing is saved, and the status light can never turn green. |
| `board.mjs` | there is no document model: cards cannot be added, moved, linked or serialised. `import` fails, so the UI does not boot. |
| `cards.mjs` | the board still pans and zooms, but it has no cards to put on it. |
| `watch.mjs` | the board works, but a file changed behind your back is not noticed: no reload of a clean card, no warning on a dirty one, no `gone from disk`. |
| `classic.mjs` | the board works as always, but there is no second arrangement: no code area, no tab strip, no sidebar column, and `mode classic` is not a mode. |
| `style.css` | the board still works, but it renders as unstyled white boxes stacked at the origin. The editor's colour layer and text layer stop lining up. |
| `main.mjs` | `index.html` has nothing to boot: a blank dark page. |
| `language.mjs` | the editor still edits, but nothing asks a subsystem for anything: no completion list, no issue strip, no hover or definition, and no formatting edit. |
| `index.html` | nothing is served at `/`; `main.mjs` is still a valid module. |
| `selftest.mjs` | nothing at runtime. You lose the only check that the protocol plumbing still works. |

`main.mjs` is the only module that imports the others, and every module in this
table stands on its own; `selftest.mjs` is the exception that imports several,
because pinning them is its whole job.

---

## Editing, dirty state and honesty about conflicts

An `editor` card holds the file text in a `<textarea>` that is **transparent**,
painted over a `<pre>` that carries the coloured spans. Re-colouring therefore
never touches the element you are typing into, so **the caret and the selection
survive every re-tokenisation**. Tokenising is debounced by 120 ms, and a reply
that arrives after you typed again is discarded.

The revision returned by `file.read` is remembered and sent back as
`base_revision` on every write. If another writer got there first the kernel
answers `STALE_REVISION`, and seIDE does **not** silently overwrite:

* the card's status line says the file changed on disk, and
* a row of buttons appears above the command line — *reload from disk*,
  *overwrite*, *leave it* — and

your text stays in the card either way. An unsaved buffer is never discarded
implicitly: reloading a dirty editor card refuses and tells you to press ctrl+S
first.

The board document is protected the same way: an autosave fires 1.5 s after the
last layout change, and a `STALE_REVISION` on the board keeps your layout in
memory and asks you to type `save force`.

### A file changed by something else

`file.changed` arrives only for writes the kernel itself made. `git checkout`, a
formatter, or another editor leaves no trace at all, so the shell asks instead:
every open `editor` card is polled through `file.stat` — once every 1.5 s, one
small call per card, no file text on the wire — and the revision it reports is
compared with the one the card read. What the comparison means is a pure
function, `watchDecision(known, stat)`, in `watch.mjs`:

| the card | the answer from disk | what happens |
| --- | --- | --- |
| has nothing unsaved | a different revision | the card reloads the bytes and says `reloaded from disk` |
| has unsaved edits | a different revision | the text stays, the status says `changed on disk (rev N) — ^S overwrites`, and the log warns |
| anything | `revision: 0` (too big, binary, or never read) | a warning, **never** a reload: "cannot compare" is not "unchanged" |
| anything | gone (or a directory now) | `gone from disk — ^S writes it back`; the text stays and `^S` recreates the file |
| anything | the revision the card holds | nothing: a stat is not news |

One rule is applied twice: `watchReport(pairs, previous)` decides per *path*
whether the answer is news at all, so a 1.5 s poll that keeps seeing the same
revision logs once, and per *card* what that card deserves. Both functions are
exported for `selftest.mjs` — along with `watchTrimmed(responses)`, the rule
below — and `tools/input_smoke.py` drives the real thing with a plain out-of-band
file write, an out-of-band edit over a dirty card, and a delete.

If the kernel was built without `file.stat` (a fork may take the method away),
the first refusal is `-32601 METHOD_NOT_FOUND`: `watchTrimmed` says so, and the
watcher stops polling and says it once in the log, instead of asking a question
the kernel cannot answer 80 times a minute. A transport failure is not that
answer, so it stays a warning and the poll goes on.

### The keys inside an editor card

The card is a text editor, so it answers the keys a text editor answers, with no
dialog anywhere:

| key | what happens |
| --- | --- |
| `Tab` | indent the lines the selection touches by one step (4 spaces); a bare caret gets one step in place |
| `Shift+Tab` | take one step back off those lines: one tab, or up to four spaces |
| `Enter` | keep the line's indentation, and step in one more after a line ending in `{`, `(` or `[` |
| `Ctrl+F` | open the card's find bar: find, next/previous hit, replace, replace-all |
| `Ctrl+S` | write the file — the board's own shortcuts never fire while you type |
| `Ctrl+Space` | ask the subsystems for completions; the list opens under the editor |
| `↑` / `↓` | move through the completion list while it is open |
| `Enter` / `Tab` | take the highlighted completion, replacing the word it completes |
| `F12` | go to the definition of the word at the caret |
| `Ctrl+I` | print the hover for the word at the caret: its first line, and where it came from |
| `Ctrl+.` / `Ctrl+Shift+.` | next / previous issue, selecting it |
| `Esc` | close the completion list, or the find bar |

Every hit is painted in the colour layer as well as selected in the textarea, so
matches stay visible while the caret is in the find bar. The indent, auto-indent
and replace edits are inserted through the browser's own insert command instead
of assigning `.value`, because a direct write throws the textarea's undo stack
away: after a `Tab`, `Ctrl+Z` still takes that `Tab` back. The pure parts
(`indentSelection`, `indentAfterEnter`, `findMatches`, `replaceMatchAt`,
`replaceAllMatches`, `markHits`) are exported for `selftest.mjs`; the wiring is
pressed for real by `tools/input_smoke.py`.

#### Completions and issues are docked rows, not a popup at the caret

A `<textarea>` has no selection rectangle to read, and a mirror element built
only to place a floating list would be a second copy of the text that can
disagree with the real one. The honest shape is a row that is always in the same
place: a completion list and an issue strip under the editor, driven by the
keyboard. Which subsystem answers a capability, how completions are ranked, and
how LSP ranges become line and column are pure and live in `language.mjs`; the
arithmetic is covered by `selftest.mjs`, and the two bars are pressed for real by
`tools/input_smoke.py` (which also fails the run on any exception the page
throws, because a listener that throws changes no DOM node).

### Finding things across the workspace

`find <text>` on the command line drops a `search` card (or re-points the one
already on the board) at the centre of the view, the same way `files` and
`project` do. It is a **literal** find, case-insensitive unless you turn the `Aa`
button on, and it runs when you ask it to rather than on every keystroke: reading
a workspace per keypress is a way to make a quiet editor feel slow.

The card lists the workspace once (`workspace.list`, with its own glob box), then
reads the files it may contain the text in and shows one row per hit:

* a row's left column is `line:column` and its right column is the line, cut
  around the hit with `…` at a cut edge, with the hit itself marked;
* clicking a row (or pressing it with the keyboard) opens that file — reusing an
  editor card already showing it — and puts the caret on that line, centring the
  card on the hit;
* the status line says what happened: `35 hits · in 10 files · 90 read`, plus
  `first 200 of N` when the file list was cut, `stopped at 200 hits` when the hit
  budget ran out, and `first 50 per file` when a single file filled its page.

The budgets are part of the answer rather than a hidden failure: at most 200
files read, 50 hits per file, 200 hits in total, nothing over 512 KiB, and
anything whose text contains a NUL byte is skipped as binary. `searchInText`,
`searchExcerpt` and `searchFiles` are pure and exported (`SEARCH_MAX_*` are the
limits), so `selftest.mjs` pins the line/column arithmetic and the budgets, and
`tools/input_smoke.py` types `find` into the real command line, waits for real
rows and checks the caret lands on the line the first row named.

### Frames: a region that moves what stands in it

`group [title]` on the command line draws a `frame` — a labelled, dashed
rectangle — round the selection, with a margin, and drops an empty one at the
centre of the view when nothing is selected. `ungroup [id...]` takes frames away
again. A frame is a card like any other: it moves, resizes and is deleted like
one, and its title is typed straight into it.

Membership is **spatial, not stored**: every card whose *centre* stands inside
the frame's rectangle moves when the frame moves, and a card dragged into (or
out of) that rectangle has joined (or left) without anything being written down.
The alternative — a frame holding a list of member ids and deriving its own box
from them — was rejected because the list needs pruning rules to stay honest and
because a box that always wraps its members can never be dragged apart from
them. `cardsInsideRect` is the whole rule; `frameRect` is the margin arithmetic
the command uses, and both are pure and exported, so `selftest.mjs` pins them
and `tools/input_smoke.py` selects the whole board, groups it, drags the frame
and checks every card inside moved by one delta.

A frame is pinned below the cards it holds (`z-index: 0`), however often it is
clicked, because a frame that covered its own contents would hide the work it is
grouping.

### The same cards as a code area: `mode classic`

`mode classic` — or the HUD button, which is labelled with the view it will give
you, `classic view` / `board view` — draws the board a second way:

| part | which card | where |
| --- | --- | --- |
| sidebar | the first `project` card, else the first `files` card, else nothing | the left column, `CLASSIC_SIDEBAR_W` (280 px) wide, `CLASSIC_SIDEBAR_MIN` (160 px) at the least, and never more than 40% of the board |
| tab strip | every `editor` card, in board order | `CLASSIC_TAB_H` (34 px) under the HUD, right of the sidebar |
| code area | the focused `editor` card, else the first editor | all that is left below the strip |

Every other card is **hidden, not unmounted** (`.card.is-hidden`), so a card's
text, its scroll position and its listeners survive a walk through the view and
back. The rules are pure and exported from `classic.mjs` —
`classicViewName`, `classicTabLabel`, `classicHud`, `classicRoles`,
`classicLayout` — so `selftest.mjs` pins them with no DOM and `input_smoke.py`
measures the same rectangles in a real window.

What the mode deliberately does **not** do: it writes nothing (the document keeps
its `x`/`y`/`w`/`h`, so `mode board` restores the pan, the zoom and every
overlap); clicking in it selects but never raises or moves a card, so a first
visit cannot dirty the board; it has no keyboard shortcut, because a hidden
keystroke is not discoverable; and the wheel stays the board's gesture, so the
classic view has no pan and no zoom and the HUD says `no zoom` rather than
quoting a number that no longer describes the screen. A window `resize` while
the mode is on re-measures the tile. A card with no role is a card with no box:
the caller hides it rather than drawing it at 0,0.

### Known limitations (deliberate, documented rather than hidden)

* Token offsets are **string indices**, not byte offsets. `lang.tokenize` scans
  the JavaScript string it was handed, so its spans tile `0..text.length` in the
  same unit `text.length` counts (UTF-16 code units) and non-ASCII text colours
  correctly — `langs/selftest.mjs` and this directory's `selftest.mjs` both pin
  that with non-ASCII fixtures. A tokenizer written in another language, or a
  client that counts bytes, has to convert.
* The colour layer and the text layer must share identical metrics. That is
  enforced from `style.css` (`--code-*`), so a card zoomed far out will scale
  them together, but a browser that substitutes a different font for one layer
  only would shear the two apart.
* Links are straight lines. There is no router, no obstacle avoidance and no
  automatic layout: where you put a card is where it stays. The one arrangement
  seIDE computes is the classic view's tile — and it is a view, not a layout: it
  is drawn from the document and never saved into it.
* Output from a long-running command is capped (200 000 characters / 2 000
  lines); the head is dropped and the card says how much went.
* Undo covers the **board**, not the text inside a card. `Ctrl+Z` (or `undo`)
  takes back the last card or link change; a textarea keeps its own undo stack,
  so typing in a note or an editor is the browser's business — including the
  edits the editor card makes itself, which go in as browser edits so `Ctrl+Z`
  still takes them back. The steps live in
  memory (`history.mjs`) and a reload forgets them.
* Multi-select acts on the **set as a whole**: it moves and deletes together, and
  a group move or delete is one undo step and one save. There is no field edit
  across a selection (no "retitle every selected card"), no lasso over links, and
  no "select by kind"; the rubber band is the only geometric selector.
* Search is literal and on demand. There is no regex mode, no search narrowed to
  a selection or to the selected cards, no replace across files, and no watching
  the workspace itself (the files an open editor card holds are watched — see
  above — but a search row is not): a stale row can point at a line that moved,
  which is why the row carries the file and line it was found at rather than an
  offset into a buffer.
* A frame's membership is a **guess about geometry**, not a fact stored in the
  document. A card clipping a frame's border has not joined it (the centre is the
  test), and a card standing inside two overlapping frames moves with either one.
  Frames do not nest, they do not clip what they hold, and there is no collapse or
  fold: a frame moves cards, it does not own them.
* The watcher is a **poll, not a filesystem notification**. It asks every 1.5 s,
  so a change is noticed up to 1.5 s late, and only for files open editor cards
  hold. `inotify` or `ReadDirectoryChangesW` would let the kernel announce an
  outside write, but that is a promise this protocol does not make: the kernel
  speaks when it is asked, and says nothing about the filesystem underneath it.
* The classic view is a **view**: no split panes, no drag-to-resize on the
  sidebar, no per-tab close (a card has no close, and the strip is rebuilt from
  the board on every render), no tab reordering that survives anything, no second
  layout to save, and no effect on the protocol or on `board.json`. Hide a card
  and it is still open; the board is what is real.
* Language answers are **advisory and asked for sparingly**. Completions are
  requested on `Ctrl+Space` only; diagnostics are debounced by 400 ms, and a
  subsystem that answers `stale: true` is asked once more with `wait` rather than
  being drawn as "nothing is wrong"; a subsystem that raises is put on ice until
  `invalidate()`, so a dead server cannot turn every keystroke into a round trip.
  Answers are not cached across buffers, hover prints one line to the log rather
  than opening a frame, and there is no signature help, no rename, no code action
  and no key for `format` — it is a method the client can ask for, not a binding.
  With no subsystem running the editor falls back to `words` (every identifier in
  the buffer), which is a completion list, not a language.

---

## Kernel contract

Everything the UI knows about the outside world is in one frozen interface
(`node shell/main.mjs serve`):

* `POST /rpc` with a JSON-RPC 2.0 request `{jsonrpc:"2.0", id, method, params}`
  → `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error:{code, name,
  message, data}}`. A request without an `id` is a notification: the server
  answers `204 No Content`, and sending one without an `id` by mistake is the
  single easiest way to get an empty, unparseable reply.
* `GET /events` → Server-Sent Events, one `data: <json>\n\n` frame per
  notification.

`rpc.mjs` consumes `/events` with `fetch` + `response.body.getReader()` rather
than `EventSource`, and re-assembles frames on a rolling buffer, so a frame split
mid-line, mid-JSON or mid-UTF-8 across chunk boundaries still arrives intact.
`RpcError` carries `code`, `errorName`, `message` and `data`, and it recognises a
stale write whether the endpoint puts the symbol in `name`, in `code` or in
`data`.

If `/rpc` is unreachable, the page shows a **"kernel not reachable"** card with a
retry button, the status light turns red, the UI stays fully interactive, and it
keeps retrying with backoff. There is never a blank page and never a
console-only error.

`subsystem.list/start/stop/status/request` are part of the same interface, not a
second one: the shell answers them out of `subsystems/` on the same terms as
`file.*`, and a `subsystem.request` is a nested JSON-RPC call whose result is the
subsystem's own. The client chooses a subsystem from the capabilities declared in
its `.sub` descriptor, so a fork that ships different subsystems needs no change
in `shell/web/`; see `docs/SUBSYSTEMS.md`.

---

## Self-test

```sh
node shell/web/selftest.mjs
```

It imports the pure parts of the shell and drives them against a fake SSE stream
with no DOM and no network: chunk-split frame reassembly, `RpcError` mapping,
`STALE_REVISION` surfacing `data.current_revision`, board add/move/link/serialize
round-trips, document repair, viewport clamping, the selection set and
`cardsWithin` (the rubber band's arithmetic), a group move/delete being one
change, the search arithmetic (line/column, excerpts, the file order and the
budgets), the frame arithmetic (the centre-inside membership test and the
rectangle drawn round a selection), the classic view (which card plays which
part, the label a tab gets, the HUD's two readings, and a tile that leaves no gap
or overlap and stays inside the viewport at several sizes), the watcher's
decision table (a clean card
adopts new bytes, a dirty one is only warned, a revision that cannot be compared
is never a reload, and one piece of news is reported once), and token-span
application to a string. It also drives `language.mjs` against fake channels:
which subsystem answers a capability and in what order, the prefix and ranking
arithmetic, LSP ranges into line and column, diagnostics normalised from either
shape, the once-with-`wait` retry when a subsystem says its answer is stale, and
that a shell with no subsystems is asked exactly once. It prints `ok N/N` (130
today) and exits non-zero if anything fails — every check is awaited before that
count is taken, which it was not until the fix recorded in `docs/BUGS.md`.
