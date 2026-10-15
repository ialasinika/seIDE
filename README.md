# seIDE

seIDE is an **IDE prototype whose purpose is to be forked** into something else —
typically a proprietary IDE with a different product name and a different audience.

It is deliberately unlike the IDEs you already know, and it is **not a complete
product**. It is a small, finished, working, honest skeleton: the parts that are
there work, the parts that are missing are missing on purpose, and every
deliberate tradeoff is written down instead of discovered.

If you want a mainstream IDE, this is not one, and it is not trying to become
one. If you want a code base small enough to read in an afternoon and reshape
without fighting a plugin API, keep reading.

![The seIDE board: an editor card with Brainfuck colouring, a note card, a runner card and two labelled links between them, above a command line](docs/board.png)

---

## What seIDE is

- A **board**: an infinite, pannable, zoomable 2-D canvas of cards. No tabs, no
  file tree. Where you put things is part of the project state.
- **Three layers**, each in a different language, each trimmable:
  - `core/` — the kernel. **C89 only**, zero third-party dependencies.
  - `shell/` — the front end and the HTTP/stdio endpoints. **JavaScript ESM**,
    zero npm dependencies.
  - `tools/` — build driver, protocol driver, a second protocol client, a
    Brainfuck interpreter, a language-descriptor generator. **Python 3.12
    standard library only**.
- A **window** made of the system's Edge/Chromium launched in
  `--app=http://127.0.0.1:PORT` app mode.
- **Languages** that are actually supported: Brainfuck, plus an SGML family
  (HTML and XML, which is what SVG is). Colouring only — see below.
- A **frozen JSON-RPC protocol** on stdio, newline-delimited, with a documented
  method list and error-code table.

## What seIDE is not

- **Not a complete product.** There is no settings UI, no terminal emulator, no
  debugger, no Git integration, no refactoring. Undo takes back a *board* edit;
  typing inside an editor card is the browser textarea's own undo stack, and
  Ctrl+Z in the board does not reach into it.
- **Not extensible.** There is no plugin system, by design. Extension means
  forking this repository and editing the source.
- **Not a native window.** The app mode of a browser is not a real application
  window; see the WRY/Tauri note below.
- **Not for every language.** IntelliSense, diagnostics, completion and
  formatting do not exist. Language support is keyword colouring, and the only
  languages that must work are Brainfuck and the SGML family (HTML/XML); see
  [Constraints, 8](#8-language-intelligence-is-keyword-colouring-and-it-lives-in-langs).
- **Not portable yet.** The kernel's platform layer is Win32.

---

## The eight constraints

These are hard constraints, not aspirations. They are what make the code base
forkable, and they are what a fork will change first.

### 1. The paradigm is the board, not tabs and a tree

The main surface is one persistent 2-D canvas. Everything you work on is a
**card** placed at a point on that canvas. A card has a `kind` (`editor`,
`runner`, `note`, `files`, `project`, `search`, `sheet`, `frame`), a position and size (`x`, `y`, `w`, `h`,
`z`), may
reference a file, and may be connected by links. The board persists to
`<root>/.seide/board.json`, so **where you put things is part of the project
state**. A non-modal command line at the bottom acts on the focused card.
See `docs/PARADIGM.md`.

This is a decision of the *shell*, not of the kernel: the kernel stores the
document, whatever it holds, and knows nothing about cards or canvases
(`docs/VIEWS.md`). A fork that wants a different main surface replaces this
document and not the core.

The board is also the only document. The shell can draw those same cards a second
way — `mode classic` puts the focused editor into a code area, the open files
into a tab strip above it and the project card into a sidebar — but that view is
a *projection*: switching to it creates no card and moves none, nothing about it
is written to `board.json`, and `mode board` puts every card back on the pixels
it had. A fork that deletes the view loses a way of looking, not a piece of
project state; the board is still where the project is.

### 2. No Electron

The window is the system's Edge/Chromium launched in
`--app=http://127.0.0.1:PORT` app mode, with a throwaway profile. There is no
Electron, no bundled Chromium and nothing to download. **This constrains the
base, not a fork:** Electron never enters the kernel or `shell/`, but a fork may
wrap the same shell in it, with the dependency in the fork's own `package.json`
— [`forks/electron-example/`](forks/electron-example/README.md) is that fork,
and it is why this repository can stay dependency-free while someone who wants
Electron still gets it.
**For a real product, the replacement path is WRY/Tauri** — currently nothing in
this repository uses either; the WRY path is described in `docs/FORK.md` and is
future work, not present work.

### 3. No plugin system, by design

Extension = fork and edit source. There is no plugin loading, no manifest, no
discovery and no sandbox.

`subsystems/` (completion, diagnostics, formatters, language servers) is not an
exception to this. It is a *layer* in this repository — descriptors and modules
that are reviewed, built and tested with the rest of the source — with a frozen
wire so a capability never becomes a method the kernel has to know. Nothing is
downloaded, registered or resolved at run time, and no stability is promised to
code this project does not own. See
[`docs/SUBSYSTEMS.md`](docs/SUBSYSTEMS.md).

What there *is* is one hook for new card kinds, because "a card is a file with a
cursor" is the assumption most likely to make a fork expensive. The kernel
stores whatever document the shell hands it, verbatim, and the shell's board
model is the only thing that knows what a card is; the shell
registers a kind with a single call:

```js
registerCardKind({ kind: "waveform", render: (card, ctx) => { /* … */ } });
```

The eight shipped kinds are `editor`, `runner`, `note`, `files`, `project`,
`search`, `sheet` and `frame` — `sheet` being a structured-data grid (typed cells, rows,
columns, TSV export) that exists to prove nothing downstream assumes text,
`project` being the workspace as one project: what the project contains, merged
with what the board has open, `search` being the workspace-wide find whose
rows open their file at the line they name, and `frame` being a labelled
rectangle that moves the cards standing inside it. See
[`docs/SURFACES.md`](docs/SURFACES.md) and
[`docs/PROJECT.md`](docs/PROJECT.md).

### 4. The build is fully offline

No package manager, no network, no third-party dependencies, no configure step.
The Makefile needs a C89 compiler and GNU make, and either finds them or does
not. `core/` includes only C89 standard headers and `<windows.h>` behind the
platform layer.

### 5. Low coupling, trivially trimmable

Each module under `core/src/` is a whole subsystem with a stated cost of
removal. `seide modules` prints the trim manifest. See `docs/TRIM.md`.

### 6. `core/` is C89 ONLY

Enforced by the compiler, not by convention:

```make
CFLAGS = -std=c89 -pedantic -Wall -Wextra -Werror -O2 -Icore/include
```

C++ comments, mid-block declarations, `long long` and variadic macros are all
rejected by `-std=c89 -pedantic -Werror`.

### 7. The project is polyglot on purpose

| layer | language | dependencies |
| --- | --- | --- |
| `core/` | C89 | none beyond libc and the OS |
| `langs/`, `shell/` | JavaScript ESM | zero npm dependencies |
| `tools/` | Python 3.12 | standard library only |

### 8. Language intelligence is keyword colouring, and it lives in `langs/`

The kernel knows about files, documents and processes — not about programming
languages. Language support lives in `langs/`, is served by the shell, and is
**deletable**: `rm -rf langs/` leaves a kernel that still builds and a shell that
still runs, rendering plain text. Two kinds of language must be supported: the
**flat** kind (Brainfuck is the worked example — a line comment, a string
delimiter and a list of tokens) and the **SGML family** (HTML and XML, which is
what SVG, RSS and the rest of the `.xml` extensions are), whose delimiters are
SGML's rather than any one language's. See `docs/ARCHITECTURE.md`,
`langs/README.md` and `docs/PROTOCOL.md`.

---

## Quick start

Everything below is exactly what was run to verify this document. The versions
it was verified against:

```text
Python 3.12.9
Node   v24.16.0
GNU Make 4.4.1        (C:\mingw64\mingw64\bin\mingw32-make.exe)
gcc.exe 14.2.0        (MinGW-W64 x86_64-msvcrt-posix-seh, built by Brecht Sanders, r3)
```

Build the kernel (produces `build/seide.exe`):

```sh
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile
```

`tools/build.py` is a thin driver over the same Makefile, and it is what proves
the toolchain is present:

```sh
python tools/build.py --check     # print resolved make + gcc and exit
python tools/build.py             # build (pass --release / --clean / targets)
```

Run the checks:

```sh
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile check       # kernel alone: 9 passed, 0 failed, 4 skipped
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile fullcheck   # whole endpoint: 13 passed, 0 failed, 0 skipped
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile probe       # every bug in docs/BUGS.md: all ok
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile smoke       # the window, headless: 5 + 34 checks, 0 failed
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile version-check  # every copy agrees, and the changelog has a home for it
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile test        # check, fullcheck, probe, cli-check, version-check, the JSON test, both JS self-tests
```

The individual pieces, if you want to run them directly:

```sh
python tools/e2e.py --seide build/seide.exe    # 9 passed, 0 failed, 4 skipped
python tools/e2e.py --seide build/seide.exe --keep-going
python tools/kernel_probe.py                   # the fixed bugs: summary: all ok
python tools/seide_cli.py selfcheck            # the second client, against a scratch workspace: summary: all ok
python tools/browser_smoke.py                  # renders the real window; SKIP (exit 0) with no browser
python tools/input_smoke.py                    # keys, wheel, the editor, multi-select, a search, a frame, a watched file and the classic view: 34 passed, 0 failed
python tools/version.py check                  # every copy of the version, and the changelog section
build/obj/test_json.exe                        # the C JSON codec: "all good"
node langs/selftest.mjs                        # 92/92 checks passed
node shell/web/selftest.mjs                    # ok 115/115 (pure JS: no DOM)
```

`make test` runs `check`, then `fullcheck`, then `probe`, then `cli-check`, then
`version-check`, then the JSON test and both JavaScript self-tests **in that
order**, so a `fullcheck` failure would stop the run before the self-tests are
reached. `cli-check` is the second consumer of the protocol: `tools/seide_cli.py`
does its own eight checks against a scratch workspace with no shell code
involved, which is what keeps the frozen contract honest (see
[`docs/PROTOCOL.md`](docs/PROTOCOL.md#a-second-client)).
 `smoke` is separate because it needs a
browser: it renders the board (`browser_smoke.py`, 5 checks) and then drives it
by hand -- Ctrl+Z and Ctrl+Shift+Z, a wheel over a card's own contents, and the
editor card's own keys: Tab and Shift+Tab, Enter after an opener, Ctrl+F, the
find bar's next-match button, replace-all, Escape, and that the textarea's own
undo still holds those edits. Then it selects the whole board with Ctrl+A, takes
one card out and puts it back with ctrl+click, draws a rubber band with
shift+drag, drags one selected card and checks the whole set moved by one delta,
runs `select all` on the command line, and deletes the set in one step that one
Ctrl+Z brings back. Finally it types `find <text>` on the command line, waits for
the search card to list what it found across the workspace, clicks the first hit
and checks the editor that opened has its caret on that hit's line, then selects
the whole board again, frames it with `group` on the command line, drags the
frame and checks every card inside it moved by the same delta, and runs
`ungroup` to check the frame goes and the cards stay put. Next it opens a file
from outside the app — the test writes it with a plain file write, then again
with different bytes — and checks the card notices on its own and reloads, that
a card with unsaved edits is warned instead of overwritten, and that deleting
the file under a card is reported with the text still in the card. Last it types
`mode classic` and measures the view in the board's own pixels — the tab strip
under the HUD, the code area filling the right column and the sidebar the left,
both ending on the board's bottom edge while every other card is hidden — clicks
a tab and checks the code area moved to that file, wheels the code area and the
strip to check the viewport did not move, and runs `mode board` to check every
card, every size and the pan and zoom came back exactly
(`input_smoke.py`, 34 checks). On a clone that has no
board yet both install `examples/board.json` for the run and remove it again
afterwards. As of this writing nothing fails.

**A file changed behind the app's back is noticed, on a timer.** The kernel emits
`file.changed` for the writes it made itself and for nothing else, so a file
touched by another program produces no notification at all. The shell therefore
polls `file.stat` — one call per open editor card every 1.5 s, carrying no file
text — and compares the revision it gets with the one the card read. A card with
nothing unsaved reloads and says `reloaded from disk`; a card with unsaved edits
keeps its text and says `changed on disk (rev N) — ^S overwrites`; a file that
has gone says `gone from disk — ^S writes it back`. The decision table is pure
and lives in `shell/web/watch.mjs`, so `node shell/web/selftest.mjs` covers it
with no DOM. A fork that trims `file.stat` out of its kernel does not break the
app: the watcher turns itself off with one log line
([`docs/PROTOCOL.md`](docs/PROTOCOL.md#file-stat)).

**The same cards, drawn a second way.** `mode classic` — or the HUD button, which
reads `classic view` / `board view` — arranges the focused editor as a code area,
the other open files as tabs above it and the project card as a sidebar. The
arithmetic is pure, lives in `shell/web/classic.mjs` and is measured in the
board's own pixels, which is why `node shell/web/selftest.mjs` can pin the tile
with no DOM and `input_smoke.py` can measure it in a real window. The board
underneath is untouched: the view computes boxes for the *same* cards from the
*same* document, a card with no place in the tile is hidden rather than
unmounted (its text, its scroll position and its listeners survive a round trip),
and the wheel is the board's gesture — so in classic mode there is no pan and no
zoom to speak of, and the HUD says so. Nothing about the view is saved, no
protocol method changed, and `mode board` restores every card to the pixels the
document gives it; [`docs/PARADIGM.md`](docs/PARADIGM.md) states what it is not.

**The protocol suite used to write to your board, and no longer does.** The
board checks drive `view.save` against the workspace they were given, but they
snapshot the whole document that was already there and restore it before the
check returns — including when the check fails. A run against `.` leaves
`./.seide/board.json` semantically identical; with the shipped starter board it
comes back byte-identical too (3107 bytes, byte-for-byte, because the kernel
writes the same canonical form back). If there was no board before
a run, there is none after it either.

**The board shipped for a fresh clone is verified, not assumed.** The
`starter board` check saves `examples/board.json` and requires cards, links and
viewport to come back exactly, byte for byte, so a hand-edit that the shell
cannot read fails here rather than on a new user's first launch. The kernel does
not judge the shape of that file (`docs/VIEWS.md`); the shell's own model is
what reads it, and `node shell/web/selftest.mjs` is where the shape is tested.

**Current state of the protocol suite:** both modes are green. Kernel mode
(`check`) reports 9 passed, 0 failed, 4 skipped — the skips are the four
language checks, which the kernel does not serve. Full mode (`fullcheck`, the
endpoint that adds `langs/`) reports 13 passed, 0 failed, 0 skipped. See
[Known rough edges](#known-rough-edges) for what is still genuinely unfinished.

Note `make test` uses `fullcheck`, which needs `node shell/main.mjs`; there is no
make target that runs only the JavaScript self-tests.

Start the app (builds the window from the system browser):

```sh
python tools/demo.py                                 # install the starter board first
node shell/main.mjs serve --workspace .
node shell/main.mjs serve --workspace . --no-open    # just serve, print the URL
node shell/main.mjs rpc --workspace .                # stdio endpoint, no browser
```

`.seide/` is gitignored, so a fresh clone opens an **empty canvas** — the layout
is per-checkout project state, deliberately not committed. `tools/demo.py`
copies `examples/board.json`, the five-card board in every screenshot here, into
`.seide/board.json`. It refuses to overwrite a board you already have unless you
pass `--force`, and `--print` shows it without touching anything. Opening an
empty board is fine too: the canvas tells you the commands, and `project` on the
command line gives you the workspace.

The kernel is usable with no UI at all:

```sh
build/seide.exe help
build/seide.exe version
build/seide.exe modules
build/seide.exe view show --path .seide/board.json --root .
build/seide.exe rpc --root . --verbose
```

---

## Repository map

```
Makefile                the whole build: CC, CFLAGS, SRC, all, check, fullcheck,
                        test, modules, run, clean, version-check, release-dry,
                        release, and the JSON test target
README.md               this file
VERSION                 the one line that decides the version; tools/version.py
LICENSE                 MIT -- the code.  Except the docs: see below
LICENSE-DOCS            CC BY 4.0 -- every Markdown file in the repository
CHANGELOG.md            what is in this version, and what is not
.github/workflows/      CI: the same make targets, on a Windows runner
.gitignore              build artefacts, workspace-local state and dist/
.gitattributes          the checkout is the repository's bytes: LF everywhere

core/                   the kernel -- C89, no dependencies
  include/              public headers: buf, vec, json, port, wksp, view, exec,
                        serve, rpc, app, module, seide_cfg
  src/                  one file per module: buf, vec, json, wksp, view, exec,
                        rpc, serve, app, main
  port/                 the only OS-aware code: sys_win32.c, proc_win32.c
  tests/                test_json.c (JSON round-trip harness for the kernel)

langs/                  language support, deliberately OUTSIDE the kernel
  brainfuck.lang        the flat family: a line comment, a string, a token list
  html.lang             the SGML family: .html/.htm/.xhtml, raw script/style/...
  xml.lang              the SGML family: .xml and the dozen extensions built on it
  lang.mjs              descriptor parsing, validation, registry
  markup.mjs            the SGML scanner (the family's delimiters, in one place)
  tokenize.mjs          the tokenizer and its tiling guarantee
  selftest.mjs          node langs/selftest.mjs -- no kernel needed
  README.md             the descriptor grammar and wire shapes

subsystems/             capability outside the kernel, owned by the shell
  words.sub             the built-in: completion and diagnostics on any file
  words.mjs             its implementation -- no server, no network, no config
  host.mjs              descriptors, lifecycle, request routing, the channel seam
  selftest.mjs          node subsystems/selftest.mjs -- no kernel, no browser
  README.md             the descriptor grammar, the wire, the seam

shell/                  the front end and the endpoints
  main.mjs              `seide rpc` (stdio) and `seide serve` (HTTP + SSE + browser)
  web/                  the board UI: index.html, style.css, board.mjs, cards.mjs,
                        history.mjs, rpc.mjs, watch.mjs, classic.mjs, main.mjs,
                        selftest.mjs, README.md

tools/                  Python 3.12, standard library only
  build.py              drives the Makefile; --check / --release / --clean
  e2e.py                drives the protocol end to end over stdio
  seide_cli.py          the second client: read, write, list, run, board
  demo.py               installs examples/board.json as this workspace's board
  bf.py                 a Brainfuck interpreter (runs examples/hello.bf)
  newlang.py            writes a conforming .lang descriptor (flat or sgml)
  version.py            the one version: show / check / set / bump
  release.py            cuts a release: preflight, verify, freeze, artifacts, tag
  msi/                  the WiX v4 installer for 1.x (never built here: no WiX)
  README.md             what each tool is for

forks/                  worked forks the release pipeline knows about
  electron-example/     the same shell in an Electron window (fork.json + files/)

examples/               hello.bf and shadow.bf (Brainfuck), page.html (every
                        SGML token kind), hello.xml, notes.svg, and board.json --
                        the starter board `tools/demo.py` installs
docs/                   PARADIGM.md, VIEWS.md, SUBSYSTEMS.md, ARCHITECTURE.md,
                        PROTOCOL.md, SURFACES.md, PROJECT.md, TRIM.md, FORK.md,
                        BUGS.md, RELEASING.md
```

Build artefacts (`build/`, and the workspace-local `.seide/`) are ignored by
Git. `examples/` is **not** ignored: the `.bf`, `.html`, `.xml` and `.json`
sources are part of the project.

---

## Known rough edges

Stated plainly, because a fork needs to know what it is inheriting.

- **`file.read` means different things at the two endpoints.** The shell adds a
  `lang` member (the detected language id, or `null`); the kernel does not,
  because it has no language layer. `docs/PROTOCOL.md` marks which members come
  from which layer.
- **Token offsets are string indices, not byte offsets.** `lang.tokenize` scans
  the string it was given, so its offsets count in that string's own unit —
  UTF-16 code units in JavaScript, which is what `text.length` counts — and
  non-ASCII text colours correctly. A client that counts *bytes* (anything not
  running JavaScript) must convert. This bullet used to claim the opposite; the
  implementation was measured (`langs/selftest.mjs` and `shell/web/selftest.mjs`
  both pin it now) and the old claim was wrong.
- **Links are straight lines.** No router, no obstacle avoidance, no automatic
  layout.
- **The shell is the only client.** There is no second front end, so the protocol
  has exactly one consumer to keep honest.

---

## Fork it in 10 minutes

Start with `docs/FORK.md` — it is the playbook, ordered by cost. The short
version:

1. Rename the product (`README.md`, `shell/main.mjs`'s `SHELL_VERSION` and
   usage text, `core/include/seide_cfg.h`, `core/src/main.c`).
2. Delete what you do not want: `seide modules` prints the cost of each module,
   and `docs/TRIM.md` lists the four edits per removal.
3. Change the window: replace `shell/main.mjs`'s browser launcher with WRY/Tauri
   (`docs/FORK.md`).
4. Add your card kind, or your language — `docs/FORK.md` has both recipes.

The protocol is frozen (`docs/PROTOCOL.md`). Keep the JSON-RPC shape and you can
replace every layer under it in any order.

The docs, in reading order: [`docs/PARADIGM.md`](docs/PARADIGM.md) — why the
board and not tabs; [`docs/VIEWS.md`](docs/VIEWS.md) — what the kernel calls a
view, and why it does not know what is in yours;
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — what each
layer is; [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the frozen wire;
[`docs/SURFACES.md`](docs/SURFACES.md) — non-text cards and the card-kind hook;
[`docs/PROJECT.md`](docs/PROJECT.md) — the workspace as one project;
[`docs/TRIM.md`](docs/TRIM.md) — how to cut a module out;
[`docs/FORK.md`](docs/FORK.md) — the fork playbook, and
[`forks/electron-example/`](forks/electron-example/README.md) — a fork that is
only a window; [`docs/RELEASING.md`](docs/RELEASING.md) — channels, branches and
what a release has to prove;
[`docs/BUGS.md`](docs/BUGS.md) — every defect probing found, with its root cause
and fix, so a fork knows what was already tried.

> Rejected alternative: **a Rust kernel**. It was dropped because a dependency's
> build script needed a C compiler, which broke constraint 4 (fully offline,
> no configure step). C89 has no build script and no dependency graph.

---

## Version, licence, CI

The version is one line in [`VERSION`](VERSION) — `python tools/version.py show`
prints what it says — and two files must copy it, because C89 and JavaScript
cannot read a file at build time: `core/include/seide_cfg.h` and
`shell/main.mjs`. `tools/version.py` writes and checks them (`make version-check`,
which runs inside `make test`), so the binary, the shell and the changelog
cannot drift apart. The last tagged release is whatever `git describe --tags`
says; an alpha is a source-only release whose notes, manifest and zip land in
`dist/<version>/` (generated, not committed). Cutting the next one is
`make release-dry` — the whole plan, nothing written — and `make release`;
[`docs/RELEASING.md`](docs/RELEASING.md) is the policy: the channels, the
branches, what each one ships, how a fork joins in, and what the pipeline does
not claim. This paragraph used to name one release, and went stale the moment
the next one was cut.

What this version is **not**: undo covers the board and not the typing inside a
card, there is no portability beyond Windows, and there is no plugin loading.
See [CHANGELOG.md](CHANGELOG.md) for what is in it and what is not.

The code is [MIT](LICENSE) — take it, fork it, rename it. The documentation
(the Markdown files, this one included) is [CC BY 4.0](LICENSE-DOCS): quote it,
translate it, rewrite it for your fork, keep the attribution. Two licences, two
scopes, both spelled out in [LICENSE-DOCS](LICENSE-DOCS).

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml): the `test` job runs
the same `make CC=gcc test` a maintainer runs, and the `smoke` job renders the
board headless.
[`.github/workflows/release.yml`](.github/workflows/release.yml) is the other
half: a pushed tag in, a rebuilt release directory and a GitHub release out,
with `tools/release.py --no-tag`. Neither file has run on a GitHub runner (they
were authored on a machine with none), so treat them as unproven until the first
green run; the commands inside them are exactly the ones in
[Run the checks](#run-the-checks).
