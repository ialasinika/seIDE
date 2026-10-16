# Bugs found by probing

This file records defects found by probing the finished prototype rather than
by reading it, in the order they were confirmed.  Each entry states what a user
would have seen, the root cause with a line reference, and what changed.

The probe scripts used during the hunt live in `build/probes/` (git-ignored,
like the rest of `build/`), so they are **not** part of a clone.  What is
shipped is the proof, and it is runnable:

```console
python tools/kernel_probe.py     # or: make probe -- every entry below, on a
                                 # scratch workspace under build/ (46 checks,
                                 # nine of them the shapes file.stat promises)
python tools/e2e.py --seide build/seide.exe    # the protocol, both modes
node langs/selftest.mjs && node shell/web/selftest.mjs
```

`tools/kernel_probe.py` is the direct descendant of the ad-hoc
`build/probes/kernel/probe_fixes.py`: same checks, but it sets up its own
throwaway workspace instead of assuming yours, so it can be run by anyone who
clones this repository.  The rest of the ledger is pinned by the self-tests
listed above, which is why those suites grew as the bugs were fixed.

Severity is what the bug costs a *fork*, which is the point of this codebase.

| # | Bug | Severity |
|---|-----|----------|
| A | `board.save` silently replaced a good board with an empty one | critical |
| B | `file.write` silently dropped an optimistic-locking check | critical |
| C | `\u0000` in a JSON string was truncated instead of refused | high |
| D | Wrong-typed `limit` was ignored instead of reported | medium |
| E | Wrong-typed `base_revision` was ignored instead of reported | medium |
| F | Revisions above 2^31 saturated and broke optimistic locking | critical |
| G | A header-only change shipped a binary that reported two versions | critical |

Entries A and E describe the kernel's board validator. seide/2 deleted it: the
kernel now stores the view document without reading it, and the board schema
lives in `shell/web/board.mjs` (`docs/VIEWS.md`). They are kept as written
because the lessons still govern that model -- never *repair* a value you cannot
read, and never let a wrong-typed guard mean "no guard at all".

---

## A. `board.save` emptied the board and reported success

**Symptom.** `board.save` with `{"document":{"version":1,"cards":{},"links":[]}}`
returned `{"saved":true}`.  So did `{"version":1,"links":[]}`.  The board on
disk went from five cards and three links to `{"version":1,"links":[],"viewport":{…},"cards":[]}`.
The card layout is the project state in this paradigm, so this is total,
silent data loss with a success reply.  (It is how the demo board in
`docs/board.png` was destroyed the first time.)

**Root cause.** `fill_defaults()` in the then-`core/src/board.c` repaired wrong
types as if they were missing ones:

```c
if (!is_arr(cards)) {            /* object, null, string -- all "fixed" */
    sde_json_set(doc, "cards", sde_json_arr());
}
```

so `validate()` saw a legal document and `sde_board_adopt()` accepted it.

**Fix.** `fill_defaults(doc, make_arrays)` now separates the two cases it used
to conflate, and only ever *adds* what is *absent*:

- a present-but-wrong-typed `version`, `viewport`, `cards`, or `links` is left
  alone, so `validate()` rejected it (`1004 INVALID_BOARD`);
- `cards` and `links` are synthesized only when `make_arrays` is set, which is
  the `sde_board_load()` path (a hand-written `board.json` may leave them out).
  A document arriving over the wire must carry both.

## B. `file.write` ignored a wrong-typed `base_revision`

**Symptom.** `file.write` with `"base_revision":"<hash>"` or `"base_revision":true`
wrote the file and reported success, with no staleness check at all.

**Root cause.** The member was read as "a number if it happens to be one":

```c
basev = sde_json_get(c->params, "base_revision");
has_base = (basev != NULL && basev->type == SDE_JSON_NUM);
```

which turns "the caller sent nonsense" into "the caller opted out of the
guard" -- a detected conflict becomes a lost update.

**Fix.** A shared `opt_number()` helper in `core/src/rpc.c` returns
`1` (number), `0` (absent or `null`), or `-1` (**present, wrong type**), and
`-1` is reported as `-32602 INVALID_PARAMS`.  `h_view_save()` uses the same
helper, so a wrong-typed `base_revision` cannot disable the view guard either.
`base_revision: null` still means "no guard", deliberately.

## C. `\u0000` was truncated instead of refused

**Symptom.** `file.write {"text":"a\u0000b"}` wrote **one byte** and reported
`"size":1` with no error.  A path containing `\u0000` read a different file
than the one named.

**Root cause.** Every string in the kernel is a NUL-terminated C string, and
`jp_string()` in `core/src/json.c` decoded U+0000 into the buffer like any
other code point.  The rest of the value vanished at the first `strlen()`.

**Fix.** `jp_string()` rejects U+0000:

```
{"code":-32700,"name":"PARSE_ERROR","message":"offset 113: string contains U+0000, which cannot be carried"}
```

The document is well-formed JSON; it is simply not representable here, and
silent truncation is the one response that must not happen.  This also settles
the framing question -- because the reply cannot carry the id (the id was
inside the text that failed to parse) it comes back as an `id:null` error,
which is correct JSON-RPC and is what the probe now asserts.

## D. Wrong-typed `limit` was ignored

**Symptom.** `workspace.list {"limit":"3"}` returned everything.

**Fix.** Same `opt_number()` helper; `-32602` now.

## E. `base_revision` as a non-number (probe A/B's sibling)

Covered by B; listed separately because it was found through the document path
(`board.save`, now `view.save`), where the same silent fallback disabled the
*view* guard.

## F. Revisions above 2^31 saturated, breaking optimistic locking

**Symptom.** After A--E were fixed, a regression appeared: `file.write` called
with a `base_revision` **bit-for-bit identical** to the `revision` the kernel
had just returned was rejected with `STALE_REVISION`, reporting a
`current_revision` that differed from the value sent.

**Root cause.** `long` is 32 bits on Windows.  `jp_number()` decoded every
JSON integer with `strtol()`, which saturates at `LONG_MAX`, so a revision of
`3123124719` came back into the kernel as `2147483647`.  (The old code had the
mirror-image problem: `sde_json_int((long) rev)` printed half of all revisions
as negative numbers, and clients echoed the negative value back through
`(unsigned long) sde_json_as_num(...)`, an undefined conversion that merely
happens to work on x86.)

**Fix.** Two halves:

- `jp_number()` checks `errno`/`ERANGE` and falls back to `strtod()` for
  integers that do not fit in a `long`; doubles are exact to 2^53, which covers
  the full 32-bit revision space.
- `sde_json_rev()` (new, `core/include/json.h`) emits a revision as a
  non-negative double.  Every revision site -- `file.read`, `file.write`,
  `file.changed`, `workspace.info`, `view.load`, `view.save`,
  `view.changed`, and both `current_revision` payloads -- now uses it, so a
  revision is always a plain positive integer on the wire.

## G. A header-only change left a binary that reported two versions

**Symptom.** One `build/seide.exe` answered two questions with two versions:

```console
$ build/seide.exe version
seide 0.2.0-alpha.1 protocol seide/1
$ python tools/kernel_drive.py
hello: {"jsonrpc": "2.0", "id": 1, "result": {..., "kernel_version": "0.1.0", ...}}
```

`version` read the number from `main.o`, which had been recompiled; `hello` read
it from `rpc.o`, which had not.  The `VERSION` file said a third thing.

**Root cause.** The Makefile's pattern rules named only the `.c` file
(`$(OBJDIR)/%.o: core/src/%.c`), and make cannot see an `#include`.  Editing
`core/include/seide_cfg.h` therefore rebuilt nothing -- `mingw32-make: Nothing to
be done for 'all'` -- and only the `.c` that had been edited by hand was
recompiled.  A version bump is exactly a header-only change: `tools/version.py`
writes `VERSION`, `core/include/seide_cfg.h` and `shell/main.mjs`, so a binary
channel that built its bundle from an existing tree shipped the *previous*
kernel while the release notes named the new one.

**Fix.** Two halves:

- The `Makefile` gives every object a prerequisite on every header
  (`HEADERS = $(wildcard core/include/*.h)`, then `$(OBJ): $(HEADERS) VERSION`),
  so a header-only change recompiles all twelve sources.  Coarse on purpose:
  that costs nothing here, and unlike `-include *.d` it has no first-build gap,
  where an object built before the rule existed would still have no `.d` file
  and stay stale.
- `tools/kernel_probe.py` compares the **binary's** own answer with the files on
  disk: `hello`'s `kernel_version` against `VERSION`, and its protocol name and
  number against `core/include/seide_cfg.h`.  `version.py check` compares the
  sources, which is why it never saw this.

**Verified.** With the stale binary the new check fails and the probe exits 1
(`hello says '0.1.0', VERSION says '0.2.0-alpha.9'`); after the Makefile change
the same bump recompiles every object and `version`, `hello` and `VERSION` agree
again.

---

## Checked and found correct

Probing the framing and path surfaces turned up no defect, which is worth
recording so a fork does not re-litigate it:

- empty line (keep-alive) -- silence, as intended;
- malformed JSON -- `-32700` with `id:null`; bare number/array/`null` frames --
  `-32600`; string, float, and object ids echoed back unchanged;
- unknown method with an id -- `-32601`; without an id -- silence, per
  JSON-RPC;
- two frames on one line -- `-32700` (the transport is newline-delimited, and
  says so);
- a 1 MB whitespace-padded frame -- handled without truncation;
- `params` as an array -- accepted and ignored, per JSON-RPC;
- `file.read` of a directory -- `1003`; of a missing file -- `1002`; of a
  binary file -- `1003`;
- `proc.stop` on an unknown run -- `1002`; with a non-numeric id --
  `-32602`; `proc.start` of a command that does not exist -- `1005`;
- `proc.send` after the input was closed -- `1005` (seide/3; the same rail
  could not be asked before the channel had a write half);
- the kernel exits cleanly shortly after stdin reaches EOF.

---

# Second wave: the shell host, the browser layer, and `tools/`

A second pass attacked the three layers adversarially instead of reading them:
`tools/` and the cross-layer protocol (full report in
`build/probes/tools/FINDINGS.md`), the HTTP host in `shell/main.mjs`, and the
browser layer in `shell/web/`.  The `N` numbers below are the ones used in that
report, so the two can be read side by side.

Regression evidence for this wave lives in
`build/probes/tools/` (`probe_limits.py`, `probe_board2.py`,
`probe_loadshape.py`, `probe_boardorder.py`, `probe_e2e_leftover.py`,
`probe_e2e_fail.py`), `build/probes/lead/`
(`probe_exec_bytes.py`, `probe_board_ids.py`, `probe_newlang.py`,
`probe_host_fixes.mjs`, `probe_dispatch.mjs`) and `build/probes/kernel/`
(`probe_fixes.py`).

**A third pass** — the process channel (`proc.*`), the subsystem host and the
client's language layer — added `N13` and the `## Subsystems` section below, plus
bullets under `## Tools` and `## Browser layer`.  Its probes, its own findings
write-up and two sabotage proofs (a suite that cannot go red is not evidence)
live in `build/probes/subsystems/`: `FINDINGS.md`, `probe_lsp.mjs`,
`probe_shell_lsp.mjs`, `probe_shell_diag.py`, `probe_lsp_race.mjs`, `eol_audit.py`,
`sabotage_rank.mjs` and `sabotage_page_error.py`.

## Tools

- **N1 — `tools/e2e.py` reset the board viewport on every run.** The suite
  overwrote `.seide/board.json` wholesale, so a developer who had panned or
  zoomed lost the layout just by running the tests.  It now snapshots the whole
  document and restores it in a `finally`.
- **N2 — `tools/e2e.py` could leave its probe text inside `examples/hello.bf`
  forever.** A failure between "write" and "restore" left the fixture mutated.
  The edit/restore pair now runs in `try/finally` via `_restore_fixture()`, and
  `probe_e2e_leftover.py` asserts the tree is byte-identical afterwards.
- **N11 — `tools/build.py --check` reported success for an unbuildable tree.**
  With no `Makefile` present it printed nothing and exited 0, so CI could not
  tell "clean" from "nothing was checked".  It now exits 2 and says so.
- **N12 — `tools/newlang.py` wrote descriptors the real parser rejects, and
  exited 0.** The generator could emit an unquoted `line_comment`, which
  `langs/lang.mjs` refuses.  It now scans quoted regions (`scan_quoted`) and
  verifies the descriptor it just wrote (`verify_descriptor`) before reporting
  success.
- **N13 — `shell/web/selftest.mjs` never awaited its own async checks.** The
  runner collected results through an `async` test function and dropped the
  promise: it printed `N/N` and exited 0 even when a check threw.  That is why
  the missing-import bug above could not be caught there -- the checks that would
  have failed were the async ones.  The runner now keeps every pending test and
  awaits them all before it reports.  Proved by breaking a check on purpose
  (`assert.equal(asked.length, 99)`): the suite exits 1 and names it.
- **`tools/input_smoke.py` could not see the app throw.** The wrapper drove a
  page whose exceptions were invisible: a listener that throws changes no DOM
  node, so a dead feature and an idle one looked identical and the run passed.
  The wrapper now installs `error` / `unhandledrejection` listeners on the app's
  window, prints `page errors: none` (or the last few), and fails on any of them;
  the count is asserted by a check of its own.  This is what turned the dead
  issue strip from a silent `rows=0` into a named exception.

## Kernel and protocol

- **N3 — the process module's output was truncated at the first NUL byte and
  reported as success.** A command printing `a\0b` produced `a` plus `exit 0`,
  so a runner card showed a short output as if it were complete.
- **N4 — the kernel could emit raw non-UTF-8 bytes inside a JSON string**, which
  the shell then had to parse.  Both are fixed by one helper, `append_safe()` in
  `core/src/proc.c`: every byte on its way into the output buffer is
  UTF-8-validated, and anything invalid becomes U+FFFD, so the reported length is
  the real length and the frame stays well-formed.  Verified by
  `build/probes/lead/probe_exec_bytes.py` (`a\uFFFDb\uFFFDc€d`).
- **N5 — `exec.stop` never emitted `exec.exit`.** A stopped run left runner
  cards spinning forever; it now (as `proc.stop`) reports `proc.exit` with code
  -1.
- **N7 — the board revision depended on JSON member order.** Two documents with
  identical content hashed differently depending on how the client spelled
  them, which made optimistic locking fire spuriously.  The new
  `sde_json_write_canonical()` (`core/src/json.c`, declared at
  `core/include/json.h:124`) writes object members sorted, and
  `sde_view_revision()` uses it (the board-specific `sde_board_revision()` went
  with `core/src/board.c`).  `probe_boardorder.py` asserts the two
  revisions are equal.
- **N8 — duplicate card ids and duplicate link ids were accepted.** Boards that
  name the same card twice are ambiguous for every consumer, so validation
  rejected them: `cards[N]: duplicate \`id\`` and `links[N]: duplicate \`id\``,
  `1004 INVALID_BOARD`.  seide/2 moved that check to the client: the kernel
  stores the document as it is, and `serialize()` in `shell/web/board.mjs`
  refuses to write one back.
- **N9 — `file.write` with no `text` member truncated the file to 0 bytes.**
  A client that mis-spelled the parameter lost the file.  `text` is now
  required (`-32602`).
- **N10 — a UTF-8 BOM in `.seide/board.json` made the kernel refuse to start.**
  Windows editors add one readily, and the failure was a refused startup rather
  than a diagnostic.  The kernel no longer reads a document at startup at all
  (a client's file is never a reason to refuse to start); `sde_view_load()`
  skips a leading BOM when a client asks for the file.
- **N6 — a board large enough to exceed the shell's 30 s call timeout could not
  be saved, and was reported as a failure while the kernel kept writing.**  Two
  independent halves.  The kernel's board validation was O(n²) (20000 cards took
  72.59 s to validate, now 0.81 s) because it re-scanned the card list for every
  id; it built an index once (`board_id`/`build_ids`/`lookup_id`/
  `first_duplicate`).  That validation is gone with `core/src/board.c`; the
  shell's timeout message still says plainly that
  giving up does **not** cancel the call, so a slow kernel is not mistaken for a
  dead one.

## Shell host (`shell/main.mjs`)

- **Cross-origin `POST /rpc` was served.** Any page the browser had open could
  drive the kernel through the local port.  A same-origin `Origin` is now
  required; the check covers `GET /events` too, while a *missing* `Origin` is
  still allowed because local tools and `curl` do not send one.
  (`probe_host_fixes.mjs`: 403 / 200 / 200.)
- **An oversized request body had no cap**, so a single POST could allocate
  without bound.  Bodies over the limit now get `413 REQUEST_TOO_LARGE` with a
  null-id error frame, and the host keeps serving.
- **Malformed percent-encoding returned 500.** `GET /%zz` threw out of the
  static handler and produced a stack-trace 500; it is now a 403, and the host
  survives.
- **A throwing `langs/lang.mjs` produced no reply at all.** `dispatch()` let the
  exception escape, so the caller waited forever on a frame that was never
  coming.  A throwing handler is now answered with `-32603 SHELL_ERROR` carrying
  the request id; a throwing *notification* still replies with nothing, and
  later frames are still answered (`probe_dispatch.mjs`, all ok).
- **A kernel parse error that cannot carry an id hung the caller.** When the
  kernel rejects a frame it could not read (a `\u0000` in a string, deep
  nesting) the error goes back with `id:null`, so the shell could not match it to
  a call and merely logged a warning while the caller waited out its full
  timeout.  The kernel reads frames one at a time, so the shell now settles the
  *oldest* pending call with that error — verified against both endpoints by
  `probe_limits.py`, which previously died on `TimeoutError` for the shell case.
- **`--workspace` with no value was silently ignored.** `node shell/main.mjs rpc
  --workspace --no-open` treated `--no-open` as the directory name.  Values that
  look like flags are now rejected with exit 2 and a usage line.
- **A port already in use leaked a kernel process.** The host exited without
  reaping the child it had already spawned; it now exits 1 promptly with no
  `seide.exe` left behind.

## Subsystems (`subsystems/`)

- **The `lsp` adapter answered `completion` and `diagnostics`; the client asked
  `complete` and `diagnose`.** The adapter's `request()` dispatch used the LSP's
  own method names while `subsystems/words.mjs` used the client's, so the builtin
  quietly answered every question the process subsystem was asked and the process
  subsystem was never asked one.  Nothing under Node caught it: the adapter's
  selftest calls the adapter directly, and the client's checks call the client
  directly.  It surfaced in `tools/input_smoke.py` as `source="words"` on a
  question a language server should have answered, which is the whole argument
  for the browser check -- two halves of one contract, tested apart, agree on
  whatever each was written to say.  One vocabulary now (`complete`, `diagnose`,
  `hover`, `definition`, `format`), and the smoke check requires `source="lsp"`.
- **An honest `stale: true` answer was shown as "nothing is wrong".** The adapter
  answers `stale` when the document's version moved after the question was asked:
  an honest "I have not looked at this text yet".  The client took it as final, so
  a buffer that had just changed could show no issues while the server was still
  catching up.  `language.mjs`'s `diagnose` now asks again once with
  `wait: 2000` -- the adapter's own wait-for-version window -- keeps `stale` in
  the answer, and the strip's `data-answer` says so.

## Browser layer (`shell/web/`)

Every entry below has a check in `shell/web/selftest.mjs` -- which grew from 46 to
53 checks for this wave -- unless the entry says a real browser is needed, as the
wheel rule does; listed line numbers are in that file.  The browser layer is the
one place a fork is most likely to write its own code, so these matter more than
their severity suggests.

- **Duplicate link ids, and `unlink` removing every link with that id.** The
  board model let two edges share an id, and `unlink("L1")` deleted all of them.
  The kernel rejects a board containing duplicate link ids (`1004`), so the UI
  could build a document its own backend refuses to save.  `addLink(from, to,
  label, id)` (`shell/web/board.mjs:443-463`) now refuses an id that is already
  used board-wide, `unlink` (`board.mjs:486-494`) splices exactly one match and
  reports whether it removed anything, and the loader (`board.mjs:190-238`)
  renames duplicate or missing link ids into free ones and reports each rename,
  which `shell/web/main.mjs:1250-1262` logs.  Checks: `selftest.mjs:681-725`.
- **`serialize()` dropped invalid cards silently.** A card that failed
  validation was skipped, so `save` reported success while the document quietly
  lost it.  It now throws naming the card — `serialize: cards[1] is not a valid
  card -- …; it was kept in the model rather than dropped from the document`
  (`board.mjs:541-584`), the same for a duplicate card id and for a link naming
  an absent card — and `saveBoard()` (`main.mjs:596-604`) turns that into a
  `refused` outcome and returns false, so a lossy save can never read as
  success.  Checks: `selftest.mjs:727-746`.
- **`renderCard(null)` threw.** A board file is user-editable, so one malformed
  entry killed the whole canvas render.  `renderCard` (`shell/web/cards.mjs:959`)
  now treats a non-object as an unknown kind and renders a visible placeholder
  (`unknownCardPlaceholder`, `cards.mjs:978-1007`, exported and pure) for
  `null`/`undefined`, primitives, arrays and unrecognised kinds.  Checks:
  `selftest.mjs:1415-1451`.
- **`ask()` leaked its listener.** The choice strip added an input listener and
  did not always remove it.  `wireChoiceStrip()` (`main.mjs:125-161`) removes the
  listener in a `finally` on every exit path — answered, abandoned, and a strip
  whose `remove()` itself throws — and `ask()` is now a four-line caller.
  Checks: `selftest.mjs:1453-1508` (stub listener count returns to 0).
- **The RPC client accepted a reply for a different request.** With several calls
  in flight, `shell/web/rpc.mjs` resolved whichever caller was waiting with
  whatever reply arrived.  It now compares `reply.id` with the id it sent and
  rejects with `BAD_REPLY` *before* looking at `result` or `error`
  (`rpc.mjs:417-434`).  Checks: `selftest.mjs:462-525` (two in-flight calls with
  swapped replies both reject).
- **`save force` could fail without saying so.** Every exit path of
  `saveBoard()` now reports through one pure helper, `saveOutcomeMessage()`
  (`main.mjs:181-216`, called at `main.mjs:559-565`): saved / unchanged /
  deferred / refused / failed / offline.  A deferred forced save stays forced
  (`saveAgainForce`), so a second `save force` cannot silently degrade into an
  unforced one.  Checks: `selftest.mjs:1510-1567`.
- **A wheel over a card panned the board instead of scrolling the card.** The
  wheel listener sat on `#board` and called `preventDefault()` unconditionally
  (`main.mjs:1135`), so the event bubbled up out of an editor's text, a sheet or
  the files list and was cancelled before the browser could scroll it: a card's
  own contents could not be scrolled at all.  The nearest scroll region below the
  board that can still move in the wheel's direction now keeps the wheel --
  `scrollTarget(node, deltaX, deltaY)` (`main.mjs:1120-1133`) reusing
  `scrollRoom()` (`main.mjs:108-114`) -- and hands it back at the end, so nested
  scrolling chains; ctrl/⌘+wheel still zooms about the cursor.  Reported from use,
  not by a probe: the arithmetic is checked in `selftest.mjs`, and the event
  itself by `tools/input_smoke.py`, which dispatches a real wheel over the editor
  (`defaultPrevented=false`, the board does not move) and over the board
  (`defaultPrevented=true`, it pans).
- **The editor's new issue strip was created and never painted.** `cards.mjs`
  imported `LanguageClient` from `./language.mjs` but used `formatDiagnostic` and
  `insertCompletion` too, so `diagnoseNow()` threw a `ReferenceError` inside an
  async call and the strip stayed exactly as it was created: hidden.  Every check
  in `tools/input_smoke.py` that waits for a row read that as "no rows", which is
  also what an idle editor looks like; only the new issue check failed, and it
  failed with no reason.  Fixed by importing what is used, and caught for good
  two ways: the wrapper's `error` / `unhandledrejection` listeners now fail the
  run (N13), and the strip writes its answer back as data (`data-answer`:
  `2 of 2`, `none`, `no file`) so a shown-and-empty strip can be told from a
  strip that never got an answer.
- **The selftest printed one number for coverage it did not have.** It runs in
  Node with no DOM, yet reported only `N/N`.  It now says so in its header and in
  a final `note:` line printed on both pass and fail:
  `note: 53 checks, no DOM -- canvas layout, focus and pointer behaviour are not
  covered`.

## Recorded, not fixed

Both of these are known and left alone on purpose; a fork should know before it
assumes otherwise.

- **A host that answers `view.save` without a `revision` leaves the client
  unable to guard the next write.** `boardRevision` stays undefined, so the next
  save omits `base_revision` and overwrites whatever is on disk.  The status line
  now says `rev unknown` rather than pretending the write was guarded, but the
  blind overwrite itself remains (`build/probes/shell/p01_save.mjs`, case C).
  The kernel always sends a revision, so this only affects a fork that replaces
  the host.
- **Two probes under `build/probes/shell/` fail against the current tree for
  reasons unrelated to the fixes above.** `board_probe.mjs` asserts an older
  board model (a flat 320x200 default size, and `addCard(geometry=null)`
  throwing) where defaults are now per-kind — a note is 300x180.  `board_e2e.mjs`
  spawns the real host and so needs a built kernel; it is a coverage gap in the
  probe suite, not a defect in `shell/web/`.
