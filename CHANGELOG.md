# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

## Unreleased

### Build

- **The release workflow can rebuild a tag without moving it, and no longer
  passes an empty argument.**  Its first tag-push run (`v0.4.2-alpha.1`,
  2026-10-19) failed at "Build the release directory from the tag": PowerShell
  7.3+ forwards the empty `$forkArg` as an empty argument, and `release.py`
  refused it as an unrecognized positional before doing anything (`usage error:
  unrecognized arguments:`).  The step builds the argument list as an array
  now, and a `workflow_dispatch` input `tag` lets the same run rebuild an
  existing tag without moving it (`gh workflow run release.yml -f
  tag=v0.4.2-alpha.1`).  The tag did not move; this is the workflow fix that
  lets CI rebuild it.  `ci.yml`'s first run was green from the same push (test
  57s, smoke 58s).
- **The publish step builds its asset list as an array.**  The first dispatch
  got past the build step and then failed in "Publish it as a GitHub release":
  with one matching file the pipeline unrolls to a scalar string, and
  PowerShell splatting a scalar string enumerates its characters, so `gh` was
  handed `D` instead of the zip's path (``no matches found for `D` ``).  `@( )`
  around the pipeline keeps it an array; the assets, the notes file and the
  tag are unchanged.
- **The source zip hashes the same in every timezone.**  `git archive` stamps
  every zip entry with the commit time in the archiving machine's local
  timezone, so the +0800 cut of `v0.4.2-alpha.1` and the UTC CI rebuild had
  different hashes over identical 131 entries (same names, CRCs and sizes).
  `tools/release.py` now pins `TZ=UTC0` for `git archive`; rebuilding that tag
  locally with the fix reproduces the published asset's SHA-256 `db30110f…`
  byte for byte.  `v0.4.2-alpha.1` was published before the fix, so its tag
  annotation still records the +0800 hash and its GitHub asset the UTC one;
  `docs/RELEASING.md` says so.

## v0.4.2-alpha.1 — 2026-10-16
### Kernel

- **A revision of 0 now means one thing: "cannot say".**  `rev_of_file()`
  returned 0 both for a file that is not there and for a file it could not read,
  and the 32-bit hash it otherwise produces can be 0 by itself, so a client's
  `base_revision: 0` could match a file it had never read.  A natural hash of 0
  is mapped to 1, a file that exists but cannot be read for its revision is
  reported apart, and
  `file.write` with a base it cannot compare is refused (`1003 IO`) rather than
  treated as a match.  This is the fix for the silent lost update the audit
  described; `docs/BUGS.md` N17, `docs/PROTOCOL.md` under `file.stat` and
  `file.write`.
- **`file.write` publishes atomically.**  Both write paths now go through
  `sde_port_write_file`, which writes a neighbouring `.tmp` and replaces the
  target, so a crash or a full disk leaves the whole old file or the whole new
  one.  `sde_port_replace_file` is one `MoveFileExA` with
  `MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED`: it no longer falls back to
  `CopyFileA`, and no longer deletes the source when it fails (N15, N16).
- **Containment asks Windows for the real path.**  A junction or symlink inside
  the workspace used to pass a lexical check while pointing outside it;
  `sde_port_path_within` now resolves the root and the deepest existing ancestor
  with `GetFinalPathNameByHandleW`/`GetLongPathNameW` and refuses anything it
  cannot place inside the root (N18).  `core/tests/test_port.c` builds a real
  junction and asserts both directions.
- **Sizes are 64-bit and a long path is refused, not cut.**  `sde_port_file_size`
  and `sde_dirent.size` are `int64_t`, the listing reads both dwords (or
  `GetFileSizeEx`), and `sde_port_list_dir` refuses a pattern that does not fit
  instead of listing a truncated one (N19).  `proc.list`'s `size` and every
  kernel size answer still go through the JSON number helper.
- **Smaller hardening from the same pass:** `sde_mutex_new` checks
  `InitializeCriticalSectionAndSpinCount` and can fail (N20); `buf`, `vec` and
  the JSON arrays refuse an unrepresentable request or a doubling that would
  wrap instead of spinning (N21); the JSON writer refuses a nesting depth the
  reader would refuse, so what the kernel accepts it can also write (N22); and
  `serve` stops reading a client whose stdout write failed instead of filling a
  pipe (N23).
- **Binary and large files have an interface now: `file.blob*`.**  `file.read`
  carries a file inside a JSON string, which cannot hold a NUL byte, and it
  refuses anything past 4 MiB, so a PNG, a compiled artefact or a 200 MiB log had
  no way in.  Five methods move the bytes through a *session* instead:
  `file.blobOpen {path, mode, base_revision?, want_revision?}`,
  `file.blobRead {session, offset?, length?}`,
  `file.blobAppend {session, data, offset?}`,
  `file.blobCommit {session, total_size}` and `file.blobAbort {session}`.  Bytes
  travel in `data` as base64 (four characters per three bytes) and one chunk is
  at most 1 MiB decoded; the kernel holds eight sessions at once and forgets one
  that has been idle for fifteen minutes, temporary file included.
- **A write session stages, and the last chunk publishes.**  `file.blobAppend`
  writes `<path>.tmp` (the first chunk creates it, and its parent directory
  exactly as `file.write` does) and `file.blobCommit` replaces the target with
  it through the same `sde_port_replace_file` `file.write` uses, so the
  publication is atomic.  `total_size` is required and must equal the bytes
  written, which makes "the last chunk" a statement rather than a guess; the
  result reports the revision `file.read` would report for those bytes, and
  `file.changed` is emitted before the response.  A refused commit does **not**
  throw the session away: the client can send more and commit again.  A write
  session left open by a client is cleaned up by `file.blobAbort`, by the next
  `file.blobOpen` on the same path (that is where a leftover `<path>.tmp` from a
  kernel that died mid-session is removed), and by the kernel's own shutdown.
- **`base_revision` is checked before a session exists.**  `file.blobOpen` with
  a `base_revision` that no longer matches is refused with the same
  `1001 STALE_REVISION` and `data.current_revision` as `file.write`, and it
  leaves no session and no temporary file behind.  A read session that asks past
  the end is answered *at* the end rather than refused, so a client cannot get
  stuck past EOF.
- **Two new modules carry it, both optional in the trim manifest.**  `base64` is
  a strict codec — a length that is not a multiple of four, a character outside
  the alphabet, padding anywhere but the end, or padding that would carry
  information is refused — and `blob` is the session table.  The port grew
  `sde_port_read_at` (offset read into a buffer, re-measuring the size) and
  `sde_port_append_file`.  A fork that cuts `blob` keeps text files exactly as
  they were (`docs/TRIM.md`); `docs/PROTOCOL.md` documents all five methods, and
  `seide modules` now prints twelve modules.

### Tests

- **The kernel has more than one C test now.**  `core/tests/test_json.c` is
  joined by `core/tests/test_core.c` (buffer and vector growth, the JSON depth
  boundary on both sides, and a 4000-document fuzz round-trip) and
  `core/tests/test_port.c` (containment, a real junction escape, `mkdirs`,
  write-read round-trip, atomic write leaves no `.tmp`, listing sizes, mutex
  creation).  `make test` builds and runs all four before the kernel's own
  probes, and `core/include/json.h` exposes `SDE_JSON_MAX_DEPTH` so the two
  sides of the depth rule cannot drift.  The port layer, which had no C test at
  all, now has 48 checks of its own.
- **`core/tests/test_blob.c` proves the sessions end to end (129 checks).**  It
  links the whole kernel except `main.c`, so the app it drives is the real one.
  It pins a base64 round trip of all 256 byte values, an over-1-MiB chunk
  refused, a 1 MiB + 300 + 2 byte file published atomically and hashing to the
  revision `file.read` reports, a stale `base_revision` refused with the current
  revision and nothing left on disk, a refused commit keeping the session and
  its temporary, read sessions (sequential chunks, an explicit offset that moves
  the cursor, an offset past the end clamped to the end, one-byte reads), one
  writer per target path, the eight-session table, a 5 MiB file that
  `file.read` still refuses while the session layer reads and hashes it, and the
  five handlers through `sde_rpc_handle`: their method names, the codes they
  refuse with (1001 and 1002, -32602, -32601), the base64 a client sends, and
  the `file.changed` a commit emits.  Writing
  it found a real bug: `sde_base64_encode` under-allocated by four bytes for any
  input that was not a multiple of three, and the test died with
  `STATUS_HEAP_CORRUPTION` until that was fixed (`docs/BUGS.md`, N24).
- **The depth test was wrong, and writing it found the right answer.**  The
  reader refuses a value at `depth >= 64`, so the deepest document it accepts
  has 63 nested containers — not the 64 the old counterexample assumed.  The
  writer draws its line in the same place, which is what
  `core/tests/test_core.c` pins.

## v0.4.1-alpha.1 — 2026-10-16
### Subsystems

- **A stopped subsystem can be started again.**  A request after
  `subsystem.stop` is supposed to start a new server (`autostart yes`); instead
  the exit event of the server that had just been stopped landed after the new
  one had registered its `initialize` and failed it, leaving a running process
  with no channel.  Found *after* `v0.4.0-alpha.1` was tagged, by pointing
  `subsystems/lsp.mjs` at a real language server: `python-lsp-server` (`pylsp`)
  answered completions, hover, a definition and pyflakes diagnostics through the
  same wire the scripted stub uses, and then refused to start a second time.
  The scripted stub reproduced it, which ruled the server out
  (`docs/BUGS.md`, N14).  The fix keeps each channel's callbacks with that
  channel and ignores a channel that is no longer in use; the lifecycle state is
  reset per life, and a stop answers a question that was waiting on pushed
  diagnostics.  `node subsystems/selftest.mjs` is 114 checks, three of them the
  stop/ask/stop/ask cycle, and `build/probes/subsystems/sabotage_restart.mjs`
  shows they fail without the guard.  The `v0.4.0-alpha.1` artifacts and tag are
  unchanged; this is the next line.

### Client

- **The editor shows line numbers, and starts that way.**  A gutter of its own
  in `shell/web/cards.mjs`, one number per line of the buffer, right-aligned
  against a rule.  The first question a diagnostic raises is which line it is on,
  so the answer is there before the click; a click on the gutter hides the
  numbers for the sessions where the columns matter more, and a second brings
  them back (the colour layer and the textarea are inset behind the same width,
  so the columns really are handed back).  The numbers are one text node in a
  `<pre>` carrying the code's own font, line height and top padding, so line *N*
  sits on line *N* with no per-row layout, and the textarea's vertical scroll is
  mirrored onto it as a transform, never a reflow.  `tools/input_smoke.py` reads
  the gutter out of the real DOM — one number per line, on, hidden by a click and
  back by the next (39 checks).

## v0.4.0-alpha.1 — 2026-10-16
### Kernel

- **The kernel's child processes gained the other half of the channel.**
  `exec.*` is gone; `proc.start {cmd, cwd?}`, `proc.send {run_id, data}`,
  `proc.close {run_id}`, `proc.stop {run_id}` and `proc.list` replace it, and
  `core/src/exec.c` / `core/include/exec.h` became `core/src/proc.c` /
  `core/include/proc.h` (`SDE_WITH_EXEC` -> `SDE_WITH_PROC`, `SDE_RPC_EXEC` ->
  `SDE_RPC_PROC` = `1005`).  A run no longer carries a **`card_id`**: the kernel
  never had a use for it, and a kernel that knows what a runner *card* is has
  the board leak all over again.  Child stdin used to be the NUL device, so a
  command could not be talked to; it is now a private pipe with a writer thread
  inside `core/port/proc_win32.c` (bounded queue, `sde_proc_write` /
  `sde_proc_close_input`), which is what makes `proc.send` safe: the RPC loop
  never blocks on a child that has stopped reading its input.  Notifications are
  `proc.output` / `proc.exit`.  `SDE_PROTOCOL_VERSION` is **3**.

### Subsystems

- New `subsystems/`: capability outside the kernel, owned by the shell, as a
  sibling of `langs/`.  A `.sub` descriptor is data (`id`, `title`, `kind`,
  `module`, `capabilities`, `autostart`, `launch`), the host owns lifetimes and
  routing, and the wire is `subsystem.list` / `start` / `stop` / `request` plus
  `subsystem.state` / `subsystem.log` / `subsystem.diagnostics`.  The kernel
  gains nothing: it was already asked `subsystem.*` and answers
  `METHOD_NOT_FOUND`, which is the point.
- `words` is the first subsystem and needs no server: word completion from the
  buffers and the project, and three diagnostics provable from the text alone
  (unclosed or stray brackets, an unterminated block comment, an odd number of
  quotes), quieted by the tokenizer when `langs/` is present and running on raw
  text when it is not.
- `lsp` is the first **process** subsystem: `Content-Length` framing,
  `initialize`, `didOpen` / `didChange` / `didClose`, `completion`, `hover`,
  `definition`, `formatting`, pushed diagnostics and a restart-safe failure
  path.  It is the first real consumer of `proc.send`, and it is pointed at
  `lsp-stub.mjs` — a scripted server that needs no toolchain — by one `launch`
  line; a descriptor naming `rust-analyzer` or any other server changes nothing
  above it.  The channel seam (`spawn(spec) -> {write, onOutput, onExit, kill}`)
  is what keeps the host free of processes.
- `shell/main.mjs` wires the two together (`ProcChannels` over `proc.*`) and
  multiplexes `subsystem.*` beside `lang.*`; both `rpc` and `serve` share one
  notification path, and a shell without a channel still lists builtins and
  refuses a `process` subsystem with `SUBSYSTEM_UNSUPPORTED` and a reason.

### Client

- **The editor card speaks the subsystem contract.** A new `shell/web/language.mjs`
  (pure, no DOM, injected transport) picks which subsystem answers a capability —
  a running one first, then a builtin, then the lowest id — asks for completions,
  diagnostics, hover, definition and format, and normalises the answers: LSP
  ranges become line/column, a diagnostic with neither a message nor a code is
  dropped, one that runs past the buffer is clamped, and a reply about text that
  has since changed is thrown away rather than shown.  A subsystem that fails is
  left alone for one round, so a dead server cannot make every keystroke wait.
- Completions are a list docked under the editor, not a floating popup: a
  `<textarea>` has no selection rectangle to read, and a mirror element would be
  a second copy of the text that can disagree with the real one.  `^Space` opens
  it, `Enter`/`Tab` takes the highlighted item, the arrows walk it, `Esc` closes
  it, and the status line names which subsystem answered.  Diagnostics land in an
  issue strip whose rows jump the caret to the diagnostic, with `^I` (hover),
  `F12` (definition) and `^.` / `^⇧.` (next and previous issue).
- The status line keeps the sentence that says *why* the card last loaded
  ("loaded · crlf · 5 bytes" against "reloaded from disk" against "saved") when a
  revision or an issue count under it is repainted; the difference between "this
  editor read the file" and "the watcher noticed it change under you" is the
  whole reason the sentence exists.

### Tools

- `tools/e2e.py`, `tools/input_smoke.py` and `tools/seide_cli.py` follow `proc.*`.
  The e2e grew a duplex check — the harness writes a child's stdin, closes it,
  sends again after the close to prove the `1005` refusal, and reads the child's
  echo and exit code back through the one channel — and `seide_cli run` opens a
  process, writes its input and streams `proc.output`.
- `tools/input_smoke.py` drives `^Space`, the completion accept, an issue row and
  the strip's click, and installs `error` / `unhandledrejection` listeners on the
  app's window: the run now fails if the page threw anything, because a listener
  that throws changes no DOM node and a dead feature used to read as an idle one.
  This is how the editor's missing import was caught — the strip was created
  hidden, the exception left it that way, and the check called it empty.

### Docs

- New `docs/SUBSYSTEMS.md` and `subsystems/README.md`: the descriptor grammar,
  the frozen wire, the error codes, the lifecycle rules and the seam — and why
  a layer with a frozen wire is still not the plugin system constraint 3
  refuses.  `docs/PROTOCOL.md` documents the thirteen-method table and
  `proc.*`; `README.md` gains the `subsystems/` map and the paragraph that says
  what constraint 3 does and does not forbid.

## v0.3.0-alpha.1 — 2026-10-15
### Kernel

- The kernel no longer knows what a view **is**.  `board.load`, `board.save` and
  `board.newId` are gone; `view.load {path}` and `view.save {path, document,
  base_revision?}` replace them.  The kernel keeps *a JSON document* at a path the
  caller names, hands it back verbatim, and never looks inside it: any JSON value
  except `null` round-trips exactly — an object shaped like a board, an array, a
  number — so `1004 INVALID_BOARD` is retired (the number stays reserved) and a
  malformed document can no longer stop the kernel from starting, because the
  kernel no longer reads one at startup.  `core/src/board.c` (`fill_defaults`,
  `validate`, `check_links`, `board_id`) and `core/include/board.h` were deleted,
  `core/src/view.c` and `core/include/view.h` took their place, and
  `SDE_WITH_BOARD` became `SDE_WITH_VIEW`.  What survives is the part a client
  cannot do for itself: the atomic neighbour-replace write, `base_revision`
  staleness with `data.current_revision` (`1001 STALE_REVISION`), the
  `view.changed` notification, and `workspace.info`'s `view_path` /
  `view_revision` — which report the document the kernel last read or wrote, not
  a workspace setting.  `SDE_PROTOCOL_VERSION` is **2**; the rename is breaking on
  purpose, so a seide/1 client is refused rather than half-served.  Reasoning,
  the failures this avoids and the price are in the new `docs/VIEWS.md`.

### Shell

- `shell/web/board.mjs` now owns the board schema, the `.seide/board.json` path
  (`BOARD_PATH`) and card ids (`makeId`, with `idFactory` left as a seam that
  nothing supplies — the old `board.newId` had no production caller).  Its rules
  are unchanged and still refuse what they always refused; the only difference is
  that the refusal now happens in the process that can explain it.  `main.mjs`
  names the path on every call and listens for `view.changed` instead of
  `board.changed`.
- The classic view, the board and the tab strip are now visibly what they always
  were in fact: **implementations of a view**, not the definition of one.  A
  second client that draws a document nobody has drawn before needs no kernel
  change and no new method.

### Tools

- `tools/seide_cli.py`, `tools/kernel_probe.py`, `tools/e2e.py` and
  `tools/demo.py` speak `view.load` / `view.save`; the CLI's `new-id` verb is gone
  with `board.newId` (the client allocates ids) and its `board` command prints
  whatever `view.load` hands back, with a note — not an error — when the document
  is not the board shape.  `tools/browser_smoke.py` and `tools/input_smoke.py`
  need no change at all: `.seide/board.json` was always just a file to them, and
  that is now the truth of it.  The probe stops pinning refusals the kernel no
  longer makes and pins the opacity contract instead: a document the board schema
  would reject is stored and handed back unchanged, a stale `base_revision` is
  `1001` with `data.current_revision`, and a save with no `document` (or `null`)
  is `-32602`.  The CLI selfcheck reads `SDE_PROTOCOL_VERSION` out of
  `core/include/seide_cfg.h` rather than hard-coding `seide/1`.

### Docs

- New `docs/VIEWS.md`: what the kernel defines (that a view exists — a place, a
  value, a revision, an atomic write, a notification) against what a client
  defines (what one is — the schema, the meaning, the path, the ids), the three
  failures that follow from confusing the two, and what it costs.  `docs/BUGS.md`
  entries A and E are kept as history with that context added.
- `docs/PROTOCOL.md` documents the two new methods, the eleven-method table, the
  retired `1004`, and `workspace.info`'s `view_path` / `view_revision`;
  `docs/ARCHITECTURE.md`, `docs/PARADIGM.md`, `docs/TRIM.md`, `docs/SURFACES.md`,
  `docs/FORK.md`, `docs/PROJECT.md`, `README.md`, `tools/README.md` and
  `shell/web/README.md` now say that the board is the shell's convention and where
  the schema lives.  The counts in README.md, tools/README.md and
  docs/ARCHITECTURE.md follow the suites.

### Checks

- `make test` (e2e 13, kernel probe, cli-check, JSON, langs 92/92, selftest
  115/115) and `make smoke` (browser smoke 5, input smoke 34) are green.  Every
  new promise was sabotaged to prove its check can fail (throwaway
  `build/sabotage_view.py`): the kernel repairing a document, a stale save
  accepted, a first-run answer that is `{}` instead of `null`, the client writing
  a card its own model cannot read, and the client booting from a path of its own
  invention.  All five were caught, and the three sources were restored
  byte-identical.

## v0.2.1-alpha.3 — 2026-10-15

### Kernel

- A new method, `file.stat`: the revision `file.read` would report, without the
  text.  It exists so a client can ask "is the file on disk still the one I read?"
  on a timer without moving bytes every second, and it is what lets the shell
  notice a write it did not make.  A file that is not there is a **result**, not
  an error (`exists: false`, `mtime: -1`, `revision: 0`), because "gone" is one of
  the answers a watcher needs; `revision: 0` always means "no revision to
  compare" — a directory, a file over the 4 MiB cap, a file with a NUL byte in it
  — and never "empty", because an empty file hashes to a real revision.  The
  escape rules and parameter checking are `file.read`'s own, so an absolute path
  or a `..` escape is still `1003 IO`.  `make probe` covers the shape in nine
  checks: the shell's watcher is its only consumer inside the app, so the rails
  are pinned by the probe — which is nobody's client — rather than by
  `tools/seide_cli.py`, whose verbs are the ones a person types.

### Shell

- The same board can be drawn as a **conventional IDE**: the command
  `mode classic` (or the HUD button, labelled with the view it will give you)
  tiles the focused `editor` card into a code area, every open editor into a tab
  strip above it and the first `project`/`files` card into a sidebar column,
  hiding the rest.  It is a **view, not a document**: switching creates no card,
  moves none, writes nothing to `board.json`, and `mode board` restores every
  card to the pixels — pan and zoom included — the document gives it; a card with
  no role is hidden rather than unmounted, so its text, scroll position and
  listeners survive a walk through the view and back; and a click in the view
  selects but never raises, so a first visit cannot dirty the board.  The role
  rules and the tile arithmetic are pure (`classicRoles`, `classicLayout`,
  `classicViewName`, `classicTabLabel`, `classicHud` in
  `shell/web/classic.mjs`) and are measured in the board's own pixels, which is
  why `shell/web/selftest.mjs` pins them with no DOM (12 new checks, 115 in all)
  and `tools/input_smoke.py` measures the tile in a real window (4 new checks:
  the tiling and its parts, a tab click moving the code area to that file, the
  wheel leaving the viewport alone, and `mode board` restoring the board exactly,
  34 in all).  The wheel stays the board's gesture, so the classic view has no
  pan and no zoom, and the HUD says `no zoom` rather than quoting a number that
  no longer describes the screen.
- A file changed by **another program** is noticed, on a timer.  The kernel emits
  `file.changed` only for writes it made itself, so the shell polls `file.stat`
  every 1.5 s for each open `editor` card and compares the revision it reports
  with the one the card read.  A card with nothing unsaved reloads and says
  `reloaded from disk`; a card with unsaved edits keeps its text and says
  `changed on disk (rev N) — ^S overwrites`; a file that has gone says `gone from
  disk — ^S writes it back`; and a revision that cannot be compared (`0`) is a
  warning and never a reload, because "cannot compare" is not "unchanged".  The
  decision table is pure (`watchDecision`, `watchReport`, `watchTrimmed`,
  `WATCH_POLL_MS` in `shell/web/watch.mjs`; the polling is in `main.mjs`), so
  `shell/web/selftest.mjs` pins it with no DOM (12 new checks, 115 in all) and
  `tools/input_smoke.py` drives the real thing with out-of-band writes (4 new
  checks: the revision a
  freshly opened card holds, a clean reload, a dirty warning, and a delete).  If
  the kernel has no `file.stat` — a fork may trim the method — the watcher stops
  polling on the first `-32601 METHOD_NOT_FOUND` and says so once in the log.
- The board can select more than one card.  `Ctrl+A` selects every card,
  ctrl/⌘-click (and shift-click) add or remove one, `Shift`+drag on empty space
  draws a rubber band that selects everything it touches, dragging any selected
  card moves the whole set by one delta, and `Delete` removes the set.  The
  selection is a set of ids with a primary member rather than a scalar
  `selectedId`; `selectedId` still names the primary, so single-card verbs are
  unchanged, and the collapse back to one card happens on mouse-up when the
  pointer never moved.  `cardsWithin` (intersection, not containment, because a
  band that clips a corner must still pick the card up) lives in `board.mjs` and
  is pure; the band is drawn inside `#stage`, so it is world-space and zooms with
  the board.  A group move or delete is one change, one undo step and one save,
  and an edge whose endpoint is deleted goes with it (`1004 INVALID_BOARD`
  otherwise).  The command line gained `select <id...> | all | none`, and `delete`
  with no argument acts on the selection.  `shell/web/selftest.mjs` is 115 checks
  and `tools/input_smoke.py` drives the gestures in a real window (34 checks).
- The workspace can be searched from the board.  `find <text>` opens a `search`
  card (or re-points the one already there) at the centre of the view; it lists
  the workspace once, then reads the files that may hold the text and shows one
  row per hit as `line:column` plus the line cut around the hit.  A row opens its
  file — reusing an editor card already showing it — with the caret on that line.
  The find is literal and runs when asked, not on every keystroke; the budgets are
  part of the status line (200 files read, 50 hits per file, 200 hits total,
  nothing over 512 KiB, NUL-containing files skipped as binary), and the status
  says when one of them stopped the list.  `searchInText`, `searchExcerpt` and
  `searchFiles` are pure and exported, so the line/column, excerpt and budget
  arithmetic is checked without a DOM.
- The editor card gained the keys a text editor needs.  `Tab` and `Shift+Tab`
  indent and outdent the lines the selection touches, `Enter` keeps the line's
  indentation and steps in one more after `{`, `(` or `[`, and `Ctrl+F` opens a
  find bar with next/previous hit, replace and replace-all (`Esc` closes it).
  Every hit is painted in the colour layer as well as selected in the textarea,
  so matches stay visible while the caret is in the find bar.  The indent,
  auto-indent and replace edits go in through the browser's own insert command
  rather than by assigning `.value`, so `Ctrl+Z` still takes back a `Tab`.  The
  arithmetic is pure and exported (`indentSelection`, `indentAfterEnter`,
  `findMatches`, `replaceMatchAt`, `replaceAllMatches`, `markHits`) and checked
  in `shell/web/selftest.mjs`; `tools/input_smoke.py` presses the keys in a real
  window.
- The board gained a container kind: a `frame` is a labelled, dashed rectangle
  that moves the cards standing inside it.  `group [title]` frames the selection
  (with a margin) or drops an empty frame at the centre of the view, and
  `ungroup [id...]` removes frames while leaving the cards they held exactly
  where they are.  Membership is **spatial**, not stored: every card whose centre
  stands inside the frame's rectangle moves with it, so a card dragged in or out
  joins or leaves with nothing written to the document — the alternative, a frame
  holding a member list and deriving its own box, needs pruning rules and can
  never be dragged apart from what it holds.  A frame renders below the cards it
  contains however often it is clicked, so it can never hide the work it groups.
  `cardsInsideRect` and `frameRect` are pure and exported; `shell/web/selftest.mjs`
  pins the membership and margin arithmetic (115 checks) and `tools/input_smoke.py`
  groups the whole board in a real window, drags the frame, checks every card
  inside moved by one delta and ungroups (34 checks).

### Docs

- Token offsets are documented as **string indices**, which is what
  `lang.tokenize` always returned: six places said byte offsets, and a client
  that believed them would slice non-ASCII text in the wrong unit.  The claim is
  now pinned by `langs/selftest.mjs` (92 checks) and `shell/web/selftest.mjs`
  with non-ASCII fixtures.  No behaviour changed — the description
  caught up with the code.
- `shell/web/README.md` documents the editor card's own keys, the multi-select
  gestures, the search card and the frame kind, `docs/PARADIGM.md` and
  `docs/FORK.md` no longer list rubber-band selection, finding across the
  workspace or grouping cards as missing (they say what a frame still cannot do
  instead), the stale claim in `README.md` that there is "no search across the
  workspace" is gone, and the check counts in `README.md` and
  `docs/ARCHITECTURE.md` follow the three suites.
- `docs/PROTOCOL.md` gained **A second client**: what `tools/seide_cli.py` is,
  the commands it speaks, and the two rails it does not invent (a `write` wants
  the revision it last read; a shell-only method is still `METHOD_NOT_FOUND`).
  `docs/FORK.md` says what that does and does not settle.
- `docs/PROTOCOL.md` documents `file.stat` — its row in the method table, the
  shapes it can take (`revision: 0` is "cannot compare", never "empty"), and the
  honest note that `file.changed` is only ever emitted for a write **this kernel
  made**, so a client that cares about `git checkout` has to ask.  A new section
  in `shell/web/README.md` describes a file changed by something else — the
  decision table, what the card says in each case, and what a fork loses by
  deleting `watch.mjs` — `docs/PARADIGM.md` and `docs/FORK.md` say what the
  watcher cannot do (it polls, it only covers files open cards hold, and the
  kernel watches nothing), and the check counts in `README.md`,
  `tools/README.md` and `docs/ARCHITECTURE.md` follow the suites.
- The classic view is documented where it can be argued with: constraint 1 in
  `README.md` now says the board is still the only document and the new paragraph
  describes the projection, `shell/web/README.md` gained `### The same cards as a
  code area: mode classic` (the role table, the tile's arithmetic, and what the
  mode deliberately does not do — write, raise, take a shortcut or move the
  wheel), `docs/PARADIGM.md` answers "No tabs" honestly (a strip drawn from the
  cards is not the tab strip the paradigm rejects), `docs/PROJECT.md` keeps the
  project card *a card* even when the view draws it in a column, `docs/FORK.md`
  gives the mechanical cut, `docs/TRIM.md` notes that cutting `board` takes the
  view with it, and the check counts in `README.md`, `tools/README.md` and
  `docs/ARCHITECTURE.md` follow the suites.

### Tools

- `tools/seide_cli.py` is the protocol's second client: `hello`, `info`, `ls`,
  `cat`, `write`, `board`, `new-id`, `run` and `selfcheck` over the same
  newline-delimited JSON-RPC, using `tools/kernel_drive.py` for the transport and
  importing nothing from `shell/`.  A contract with one consumer is a contract
  nobody has tested, so this one has to stand on `docs/PROTOCOL.md` alone.  It
  keeps the protocol's rails rather than inventing its own: `write` refuses to
  replace an existing file without `--base-revision` or `--force`, `run` streams
  `exec.output` and exits with the child's code, and a refusal prints the kernel's
  code and name and becomes the exit code.  `selfcheck` drives eight checks
  against a scratch workspace under `build/` — hello, a non-ASCII write
  round-trip, a stale revision leaving the file untouched, the listing, the
  shipped starter board through `board.save`, a child's output and exit code,
  that `lang.list` is still the shell's (`-32601`), and that the command line
  itself refuses to overwrite a file with no `--base-revision`.  `make cli-check`
  runs them, and they are part of `make test` now.

## v0.2.1-alpha.2 — 2026-10-15
### Docs

- The README's version paragraph no longer names one release.  It said
  `0.2.0-alpha.2` and went stale the moment 0.2.1-alpha.1 was cut: the tooling
  checks the version copies, not prose.  The paragraph now points at
  `git describe --tags` and `dist/<version>/`.

### Tools

- `tools/release.py` and `tools/version.py` print UTF-8 where the stream allows
  it.  A run on a cp936 console died with `UnicodeEncodeError` while printing
  `make test`'s own output (`ok   U+1F600 -> F0 9F 98 80`), which is the worst
  place to stop -- after the tag already exists.  Captured child output had
  already been fixed; this is the printing half of the same problem.

## v0.2.1-alpha.1 — 2026-10-15
### Shell

- A wheel over a card's own contents scrolls the card instead of panning the
  board.  The wheel listener sits on the board and the event bubbles up from
  inside a card, so panning was unconditional: an editor's text, a sheet and the
  files list could not be scrolled at all.  Now the nearest scroll region under
  the pointer keeps the wheel while it has room in that direction, at its end
  the board pans again, and ctrl/⌘+wheel still zooms wherever the pointer is.
  `scrollRoom()` holds that rule's arithmetic and is checked in
  `shell/web/selftest.mjs` (70 checks now); `tools/input_smoke.py` dispatches the
  real event over a card and over the board and checks who wins.

### Tools

- `tools/e2e.py` removes the empty `.seide/` directory left behind when the
  suite created the board and put it back: a test run should not leave a state
  directory nobody asked for.  `make test` in a fresh clone now ends with the
  tree exactly as it started.
- `tools/undo_smoke.py` is now `tools/input_smoke.py`: it drives the window's
  input, and the undo keys are no longer the only thing it checks.  The wrapper
  page and the browser it launches are the same; the name now says what it is.

## v0.2.0-alpha.3 — 2026-10-15
What the 1.0.0 rehearsal turned up.

### Releases

- A fork release's notes name the fork and its delta in a sentence of their own
  instead of trailing them after the MSI clause.
- A fork's delta archive keeps the `forks/<name>/` prefix, so unpacking it over
  the base tree lands exactly where the base tree keeps forks.  `APPLY.md` says
  so, which is what makes "copy this over the base tree" literally true.
- A 1.x bundle cut with `--no-msi` says the installer is missing on purpose in
  its own `START-HERE.txt`, not only in the notes beside it.

### CI

- `.github/workflows/release.yml` takes a pushed tag and rebuilds the release
  that was cut locally: it checks that the tag names `VERSION`, runs the same
  suite, writes the same notes, manifest and artifacts with
  `python tools/release.py --no-tag --no-freeze --allow-branch`, keeps the
  directory as a workflow artifact and publishes it as a GitHub release
  (`--prerelease` when the version carries a pre-release identifier).  Like
  `ci.yml`, it has never run on a GitHub runner and says so in its own header.
- `tools/release.py --no-tag` no longer requires the tag to be free.  A run that
  will not create a tag should not refuse because one already exists, and that
  is exactly the position a tag push is in.

### Tools

- `tools/release.py` captures a suite's output as UTF-8, with replacement
  characters instead of an exception, and tells the child Python to write UTF-8.
  The locale on the machine a release is cut on is cp936, and a suite that
  printed an em dash made the capture come back empty: a real run's notes said
  `exit 0: (no output)` for a command that had printed 13 KB of evidence.

## v0.2.0-alpha.2 — 2026-10-15
The build stopped contradicting itself about its own version, and the release
pipeline can now rehearse a GA on a machine that has no Windows installer
toolchain.

### Build

- Every object file depends on `VERSION` and on the headers in `core/include/`,
  so a version change rebuilds the kernel.  `tools/version.py set` writes the
  number into a header, and make used to see only `.c` files: the objects that
  included `seide_cfg.h` kept the previous version, and one binary reported two
  different numbers -- `seide version` the new one, `hello` the old one.
- `docs/BUGS.md` entry **G** records the symptom, the cause and both halves of
  the fix, and `tools/kernel_probe.py` grew the three checks that would have
  caught it: the binary is asked which version and protocol it was built with,
  and the answers are compared with `VERSION` and `core/include/seide_cfg.h`
  (43 -> 46 checks).  A kernel built from older headers now fails `make probe`
  instead of shipping.

### Releases

- `tools/release.py --no-msi` skips the installer that a 1.x final or LTS
  release requires, and says so in the notes and in `manifest.json`
  (`msi: null` plus the reason).  WiX is not installed on the machine the
  `1.0.0` path is rehearsed on, so the rest of that release -- the bundle, the
  fork, the notes, the tag -- can be exercised for real instead of faked.

Verified in this tree: `make test` exit 0 (13 served checks, 13 full checks,
`make probe` 46 checks all ok including the three new ones, the C JSON test
`all good`, `langs/selftest.mjs` 87/87, `shell/web/selftest.mjs` 69/69).

## v0.2.0-alpha.1 — 2026-10-15
The release pipeline.  Until now a release was a tag someone remembered to
create and a bundle someone remembered to zip; there is a tool for it now, and
it refuses to guess.

### Version

- `VERSION` at the repository root is the one place a seIDE version is decided.
  Two files carry a copy, because C89 and JavaScript cannot read a file at
  build time without a step this project does not have one of, and
  `tools/version.py` keeps them in step: `core/include/seide_cfg.h` and
  `shell/main.mjs`.  The duplicate define that used to sit in `core/src/main.c`
  is gone.
- `tools/version.py check` runs inside `make test`, so the copies cannot drift
  apart, and it also refuses a changelog whose top section names a different
  version than `VERSION` does.
- `tools/version.py show|check|set|bump` print, write and advance the number:
  `0.2.0-alpha.1` -> `0.2.0-alpha.2` -> `0.2.0-beta.1` -> `0.2.0-rc.1`.  A
  release has no pre-release suffix, so `bump` stops there and asks for the
  next version by name instead of inventing one.

### Releases

- `tools/release.py` cuts a release in five steps: preflight (version, branch,
  clean tree, free tag), verify (`make test`, plus `make smoke` from beta up),
  freeze (the changelog gets its date, in its own commit), artifacts, tag.  The
  release directory holds the artifacts, `SHA256SUMS`, `RELEASE-NOTES.md` and
  `manifest.json` -- the manifest being the machine-readable twin of the notes,
  so a mirror or a fork can assert exactly what it has.
- The channel table is the same one docs/RELEASING.md describes: alpha ships
  the source archive only, beta/rc/final ship that archive and the runnable
  win64 bundle, and 1.x final and LTS additionally ship the MSI and a bundle
  per named fork.  The source archive is on every channel on purpose: a binary
  nobody can rebuild is not a release this project knows how to make.
- `--dry-run` prints the whole plan and writes nothing.  `--no-tag`,
  `--skip-tests`, `--with-msi` and `--allow-branch` exist for rehearsals, and
  each of them changes what the notes claim about the release.
- Nothing is pushed unless `--push` is given.  This repository has no remote
  configured, so today an alpha is a local archive, a local tag and a manifest
  that says so.
- The branch model is in docs/RELEASING.md: `main` integrates, `release/<major>.<minor>`
  is cut for the first beta, `lts/<major>.<minor>` opens after 1.0.0.  The LTS
  window is deliberately not fixed yet.

### Forks

- `forks/<name>/fork.json` makes a fork something the pipeline knows about: it
  gets its own tag (`<name>-v<version>`), its own bundle with the fork's files
  laid over the bundle root, and a `<name>-fork.zip` holding the fork's whole
  delta plus an `APPLY.md` that says what to lay it on.
- `forks/electron-example/` is a worked example: an Electron window around the
  same shell, with `electron` in the fork's own `package.json`.  Electron never
  enters the kernel or the base shell -- that is the point of keeping it in a
  fork, and it is why this repository can stay dependency-free.

### Installer (1.x only)

- `tools/msi/` expands a WiX v4 source for a staged bundle and calls `wix` to
  bind it; the per-machine install ships the kernel, the shell, the docs and a
  Start Menu shortcut.  WiX is deliberately not a build dependency: a machine
  without it gets a sentence that says so rather than a fake `.msi`, and a 1.x
  final or LTS release treats the MSI as required rather than optional.

## v0.1.0-alpha — 2026-10-15

First alpha.  Everything below was built after this date's earlier work on the
prototype, and the whole tree passes `make test` plus `make smoke`.

### Licence

- The code is MIT ([LICENSE](LICENSE)) and the documentation is now
  **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS), with the scope list, the
  attribution notice to keep, and the official legal code).  Every Markdown file
  in the repository is documentation; everything else is code.

### Board undo and redo

- `Ctrl+Z` / `Ctrl+Shift+Z` (`Ctrl+Y` too), and the `undo` / `redo` commands,
  take back the last **board** change: a card added, removed, moved, resized or
  edited, a link made or dropped, z-order brought forward.  Typing inside a card
  keeps the textarea's own undo, as in any other editor — a sentence is not a
  board step.
- The step list lives in `shell/web/history.mjs`, in memory only: a reload
  forgets it, and saving does not create a step.  Same-label edits within 700 ms
  fold into one step, and 200 steps are kept.
- Verified by nine DOM-free checks in `shell/web/selftest.mjs` (69 checks in
  total) **and** by `tools/undo_smoke.py`, which boots the real app in the system
  browser, adds a card by double-clicking empty space, and then sends the
  keystrokes: six checks, including that Ctrl+Z with a text field focused leaves
  the board alone.  `make smoke` runs it.

**The board is still the project state.** Cards on an infinite plane, links
between them, no tabs and no file tree.  A fresh clone opens an **empty canvas**
(the layout lives in `.seide/`, which is git-ignored) — `python tools/demo.py`
installs the five-card starter board from `examples/board.json` if you want the
screen in the README.

### Kernel (`core/`, C89, no dependencies)

- Newline-delimited JSON-RPC over stdio; `hello`, `workspace.info`,
  `workspace.list`, `file.read`, `file.write`, `board.load`, `board.save`,
  `board.newId`, `exec.start`, `exec.stop`, `exec.list`.
- Modules are trimmable per line in the Makefile's `SRC` list; `seide modules`
  prints what each one costs.
- The kernel knows no languages: `langs/` is served entirely by the shell.

### Languages (`langs/`, the shell's layer)

- A descriptor grammar (`.lang`) with two **families**: `flat` (Brainfuck) and
  `sgml` (HTML, XML/SVG and friends).  Adding a language is one text file — no
  code.
- Flat: comments, block comments, strings, keyword/command/type/constant token
  lists, scanned in a frozen order.
- SGML: elements, attributes, entities, CDATA, doctype/PI, comments, and
  per-descriptor raw elements (`script`/`style`/`textarea`/`title` for HTML).
- `lang.tokenize` returns spans that tile the file with no gaps or overlaps, in
  the same wire form for both families (`node langs/selftest.mjs`, 87 checks).

### Shell (`shell/`)

- `seide rpc` (stdio) and `seide serve` (HTTP + SSE + the system browser in
  `--app=` mode).  No Electron, no bundled Chromium, no npm dependencies.
- Six card kinds: `editor`, `runner`, `note`, `files`, `sheet` and `project`.
- The `project` card answers "what is in this project, and what do I have open
  in it": the workspace listing folded by folder, merged with the open editors,
  with one panel per board and a filter.
- Autosave with optimistic locking on every write; a stale write is refused,
  never silently merged.

### Tools (`tools/`, Python 3.12 standard library only)

- `demo.py` installs the starter board; `build.py` drives the Makefile;
  `e2e.py` drives the protocol end to end; `newlang.py` writes a conforming
  descriptor; `bf.py` is the Brainfuck reference interpreter;
  `kernel_probe.py` re-checks every fixed bug; `browser_smoke.py` renders the
  window headless and asserts on the DOM; `undo_smoke.py` presses Ctrl+Z in it.

### Bugs found and fixed before this release

Four adversarial probing rounds found 33 defects; 31 are fixed and each one is
recorded in [`docs/BUGS.md`](docs/BUGS.md) with its symptom and root cause.  The
worst were silent data loss in `board.save`, `file.write` ignoring a
wrong-typed `base_revision`, and validation that was quadratic in the number of
cards (20 000 cards: 72.59 s → 0.81 s).

Two more were found by cloning the repository and running the suite in the
clone, which is the only way to see what a new reader sees:

- **A clone on Windows got CRLF line endings.**  Git for Windows ships
  `core.autocrlf=true`, so `examples/hello.bf` arrived as 841 bytes instead of
  820 and the byte-exact fixture check failed on a checkout nobody had edited.
  `.gitattributes` now pins `* text=auto eol=lf`, and `kernel_probe.py` compares
  the fixture against what it read at the start of the run instead of a size
  written into the source.
- **`make smoke` failed on a fresh clone**, because there was no
  `.seide/board.json` to paint (it is gitignored).  It now installs
  `examples/board.json` for the run and removes it again.

### Verification

`make check` (9 passed, 0 failed, 4 skipped), `make fullcheck` (13/0/0),
`make probe` (43 checks, all ok), the C JSON test, `langs/selftest.mjs` (87/87),
`shell/web/selftest.mjs` (69/69), and `make smoke` in the real browser
(`browser_smoke.py` 5/0, `undo_smoke.py` 6/0) — all of them also run from a fresh
`git clone` of the tagged commit.  Two defects are recorded as **not** fixed in
`docs/BUGS.md`; `browser_smoke.py` still drives no pointer, and says so in its own
output.

### Known limits

- Windows only: `core/port/` has one implementation (`sys_win32.c`,
  `proc_win32.c`).  The port layer is the only OS-aware code.
- No undo of the typing inside a card, and board undo steps are not written to
  disk: a reload forgets them.
- The card-kind hook is fork-time only: there is no plugin loading.
- CI (`.github/workflows/ci.yml`) is written but has never run on a GitHub
  runner — it was authored on a machine without one.  Its steps are exactly the
  local commands above.
