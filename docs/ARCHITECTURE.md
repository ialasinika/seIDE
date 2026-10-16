# Architecture

seIDE is three layers in three languages, connected by one frozen protocol.
This document describes what each layer is, how the processes are arranged, and
why the kernel deliberately knows nothing about programming languages.

---

## The three layers

| layer | directory | language | what it is |
| --- | --- | --- | --- |
| kernel | `core/` | C89 | files, view persistence, child processes, the JSON-RPC method table |
| shell | `shell/`, `langs/` | JavaScript ESM | the endpoints, the board UI, language colouring |
| tools | `tools/` | Python 3.12 | build driver, protocol driver, a second protocol client, Brainfuck interpreter, descriptor generator |

The languages are not an accident and not a fashion statement:

- **C89** for the kernel because constraint 4 (fully offline, no package
  manager, no configure step) is easiest to keep when the compiler is the only
  build system. `-std=c89 -pedantic -Werror` makes the subset unarguable.
- **JavaScript ESM** for the shell because the UI is a web page already, and
  because Node can run the same modules the browser runs (no build step).
- **Python 3.12** for the tools because a protocol driver wants batteries and
  because Python is present on any machine that has this repository working.

Zero dependencies across all three. The shell has no `package.json` and no
`node_modules/`; the tools import nothing outside the standard library.

---

## Process topology

```
                 +-----------------------------+
   browser  <--> |  shell/main.mjs             |
   (Edge/       |  `seide rpc`  or            |
    Chromium    |  `seide serve`              |
    --app=)     |    - HTTP static + /rpc     |
                 |    - SSE /events            |
                 |    - lang.list              |
                 |    - lang.tokenize          |
                 |    - workspace.info + langs |
                 +--------------+--------------+
                                |
                    newline-delimited JSON-RPC
                       over stdin / stdout
                                |
                 +--------------v--------------+
                 |  build/seide.exe rpc        |
                 |    - workspace.* file.*     |
                 |    - view.*                 |
                 |    - proc.*                 |
                 |    - hello                  |
                 +-----------------------------+
```

The shell **spawns the kernel** and owns its lifetime. `shell/main.mjs` locates
the binary at `build/seide.exe` on Windows or `build/seide` elsewhere
(`DEFAULT_KERNEL`), writes one JSON frame per line to its stdin, and reads lines
from its stdout.

### stdout is protocol-only

This is the transport's one non-negotiable rule, stated in `core/include/serve.h`:

> Contract: stdout carries protocol frames and nothing else. Every diagnostic
> goes to stderr.

Everything a human should read — the port the window was served on, "ready",
"stop", usage text, frame-too-large notices that cannot be a protocol event —
goes to stderr. The shell writes kernel stderr through to the terminal, so
diagnostics stay visible without corrupting the stream.

### Concurrency inside the kernel

The kernel is single-writer by construction. One reader loop
(`sde_serve` in `core/src/serve.c`) answers requests, and the `proc` module's
single pump thread may publish `proc.output` at any moment. Both paths go
through the same emit callback, and the emit callback takes a mutex around its
`stdout` write:

```c
/* core/src/serve.c */
/* The output mutex is the one piece of synchronisation in the transport ... a
   half-written frame would desynchronise the shell's parser permanently. */
```

The `proc` module polls live children every 15 ms (`SDE_PROC_IDLE_MS`) instead
of giving each child a blocking reader thread. That is what keeps "one writer"
true: adding a thread per run would have meant adding a lock per notification.
The one extra thread is the writer that drains `proc.send` (see
`core/port/proc_win32.c`), and it never touches the transport: it writes to a
child's stdin, so a slow reader can delay a `proc.send` but never a frame.

### Framing

One JSON object per line, in both directions. `\n` is the frame delimiter;
leading and trailing whitespace on a line is trimmed, and a blank line is a
keep-alive that is ignored. A single frame is capped at 64 MiB
(`SDE_SERVE_MAX_LINE`); an oversized frame is reported via a `log` notification
and dropped rather than killing the session.

Requests are answered with a response carrying the same `id`. A frame with no
`id` is a notification and is never answered. The full contract is in
`docs/PROTOCOL.md`.

---

## Module inventory (the trim manifest)

`seide modules` prints the same table that lives in `sde_module_table[]` at the
top of `core/src/main.c`. It is the authoritative list of what the kernel is
made of and what deleting each piece costs. `optional` means the kernel still
builds and runs without it.

| module | role | what a fork loses by deleting it | optional |
| --- | --- | --- | --- |
| `buf` | growable byte buffer, the kernel's only string type | nothing builds: every other module formats through it | no |
| `vec` | growable pointer array, used for lists without a fixed bound | nothing builds | no |
| `json` | JSON parse/serialise; the protocol's value type | nothing builds | no |
| `port` | the platform boundary: files, paths, threads, processes | nothing builds; this is the layer a fork replaces to leave Win32 | no |
| `wksp` | workspace reads/writes, path containment, content revisions | files can no longer be opened or saved; only the canvas remains | yes |
| `view` | the client's view document: opaque JSON, atomic persistence, revisions | no document survives a restart; the client is left with what it holds | yes |
| `proc` | child processes as duplex channels: start, write, close, stream | nothing can run: runners and process subsystems stop | yes |
| `serve` | newline-delimited JSON-RPC over stdin/stdout | the kernel has no way in; useful only as a linkable library | yes |
| `rpc` | the method table that turns frames into actions | nothing is callable; keep it and the kernel has no verbs | no |
| `app` | constructs and owns the shared state modules are handed | nothing builds | no |

Ten modules. Six required (`buf`, `vec`, `json`, `port`, `rpc`, `app`), four
optional (`wksp`, `view`, `proc`, `serve`). Beyond the module table there are
two compile-time switches in `core/include/seide_cfg.h`:

```c
/* Compile-time switches a fork flips to cut whole subsystems out. */
#ifndef SDE_WITH_PROC
#define SDE_WITH_PROC 1
#endif
#ifndef SDE_WITH_VIEW
#define SDE_WITH_VIEW 1
#endif
```

The `rpc.c` method table is written under those switches, so turning one off
removes both the subsystem and the verbs that reach it. See `docs/TRIM.md`.

### The platform boundary

`core/port/` is the only code that knows which operating system this is:
`sys_win32.c` (files, paths, threads, mutexes, stdout/stderr) and
`proc_win32.c` (child processes with two pipes). The Makefile states the
contract for a fork:

```make
# The platform layer is the one place that knows which OS this is.  A fork
# targeting another system writes core/port/sys_<name>.c and proc_<name>.c and
# selects it here; nothing above core/port changes.
```

`core/include/port.h` uses opaque structs and function pointers deliberately, so
a fork can swap the implementation without recompiling its callers. Paths
crossing that API always use `/` as the separator; the Win32 implementation
accepts both on input and normalises internally.

`core/include/seide_cfg.h` must be included **first, before any system header**,
and raises two Win32 macros that the kernel depends on:

- `__USE_MINGW_ANSI_STDIO 1` — MinGW hides the C99 `snprintf`/`vsnprintf`
  family when `__STRICT_ANSI__` is set; this asks for the conforming
  implementations back.
- `_WIN32_WINNT 0x0600` — needed before `<windows.h>` so condition variables and
  `TryEnterCriticalSection` are visible.

---

## Why the kernel is language-agnostic

The kernel knows about files, documents and processes. It has **no tokenizer, no
keyword table, and no shipped grammar**. `core/include/app.h` states it:

> The kernel deliberately knows nothing about programming languages. There is no
> tokenizer, no keyword table and no shipped grammar here.

And `core/src/main.c`'s own usage text repeats it:

> Language support is deliberately not a kernel concern: `.lang` descriptors and
> the tokenizers live in `langs/` and are served by the shell. The kernel
> knows nothing about programming languages.

Why is this a decision rather than an omission?

1. **It keeps the kernel honest.** Every method in `rpc.c` does one thing to
   files, processes or the client's document. Nothing in C has to grow a table of
   language names, and nothing in C has to be rebuilt to support a new language.
2. **It makes language support deletable and replaceable.** `rm -rf langs/`
   leaves a kernel that still builds and a shell that still runs, rendering
   plain text. A fork that wants Rust-quality colouring can reimplement two
   methods — `lang.list` and `lang.tokenize` — in any language, anywhere, and
   delete `langs/`.
3. **The alternative was tried and rejected.** An earlier structure put the
   language layer in the kernel's process. It forced every colouring change to
   be a C rebuild, and it coupled the JSON-RPC method table to a data format
   that changes far more often than the file/document/process contract does.
4. **The wire is the seam.** `lang.list` and `lang.tokenize` have exactly the
   same shape as kernel methods, so a client cannot tell — and does not need to
   know — which layer answered. The shell multiplexes them onto one endpoint
   with one `dispatch()` function (`shell/main.mjs`), used identically by
   `seide rpc` (stdio) and `seide serve` (HTTP), so the wire behaviour cannot
   drift between the two modes.

Two shapes of language are supported, and the difference is where the delimiters
live. A **flat** language (`langs/brainfuck.lang`) states its markers as data: a
line comment, a string delimiter, a token list. The **SGML family**
(`langs/html.lang`, `langs/xml.lang`) cannot be expressed that way — its
delimiters are SGML's, shared by every member — so `langs/markup.mjs` holds one
scanner for all of them, and a descriptor only names its extensions and the
elements whose body is raw text rather than markup. Adding another SGML dialect
is therefore still a data change, and the wire is unchanged: the same ten token
kinds, the same tiling guarantee.

The consequence for a forker: **language features are the cheapest thing in
this repository to change and the safest thing to delete.** The seam between the
kernel and a view (`docs/VIEWS.md`) and the protocol are the load-bearing parts.

---

## The shell, inside

`shell/main.mjs` is the only Node file the user runs. It has two modes:

| mode | command | what it is |
| --- | --- | --- |
| stdio front end | `node shell/main.mjs rpc --workspace .` | spawns the kernel, forwards every frame, answers `lang.*` itself; this is the "full endpoint" `tools/e2e.py --seide-cmd` drives |
| HTTP front end | `node shell/main.mjs serve --workspace .` | static files from `shell/web/`, `POST /rpc`, `GET /events` (SSE), then launches the system browser in `--app=` mode |

Both modes share one `dispatch()`, so a method behaves the same either way.
Language support is loaded with a **dynamic import inside a `try/catch`**, which
is what makes deleting `langs/` survivable at runtime rather than a startup
failure; the fallback is `PlainLanguages`, which reports no languages and
returns one `plain` token covering the input.

The browser side, `shell/web/`, is module-per-concern:

| file | role | delete it and ... |
| --- | --- | --- |
| `index.html` | the entire page | nothing loads |
| `style.css` | layout, card chrome, the editor's two-layer metrics | cards render unstyled |
| `board.mjs` | the board model: cards, links, viewport, serialise | seIDE stops being seIDE; there is nothing to render |
| `cards.mjs` | one renderer and behaviour set per card kind | the board pans but has no cards on it |
| `rpc.mjs` | the client side of the kernel protocol | the board renders as an empty canvas |
| `history.mjs` | the undo ring: document snapshots, coalescing, the redo branch | the board works, but `Ctrl+Z` does nothing |
| `watch.mjs` | the decision table for a file that changed under an open card (pure; the polling is in `main.mjs`) | the board works, but an outside write is never noticed |
| `classic.mjs` | the same cards arranged as a code area, a tab strip and a sidebar (pure; the pixels are in `main.mjs`) | the board works, but `mode classic` has no tiling to draw |
| `language.mjs` | the client half of the subsystem contract: which subsystem answers a capability, prefix and ranking arithmetic, LSP ranges into line/column, diagnostics | the editor still edits; completions, the issue strip, hover, definition and format go quiet |
| `main.mjs` | the only file that knows about the whole app | `index.html` has nothing to boot |
| `selftest.mjs` | `node shell/web/selftest.mjs`, no DOM, no network | nothing; it is only a test |

`board.mjs` is deliberately UI-free — no `document`, no `window`, no timer — so
the same object is used by the browser and by `selftest.mjs` under Node.
`classic.mjs` and `watch.mjs` follow the same rule: they are arithmetic and
decisions, and `main.mjs` owns the pixels and the polling.

The HTTP front end serves `shell/web/` as static files, so there is no build
step between editing these modules and reloading the page. `index.html` loads
`./main.mjs` as a module, and the browser resolves the rest of the imports.

---

## What the build proves

The Makefile's verification targets, in the order `make test` runs them:

| target | command | what it proves |
| --- | --- | --- |
| `check` | `python tools/e2e.py --seide build/seide.exe` | the kernel alone: protocol, files, the view document, the process channel |
| `fullcheck` | `python tools/e2e.py --seide-cmd "node shell/main.mjs rpc --workspace ."` | the whole endpoint, including the language layer |
| `probe` | `python tools/kernel_probe.py` | every bug in `docs/BUGS.md`, against its own scratch workspace under `build/` |
| `cli-check` | `python tools/seide_cli.py selfcheck` | the protocol's second consumer: eight checks -- hello, a write round-trip, the stale-revision rail, the listing, a document the kernel stores without reading it (and the stale write it refuses), a child's input, output and exit code all crossing one channel, that a shell-only method is still `METHOD_NOT_FOUND`, and that the command line refuses to overwrite a file it was not given a base revision for |
| `version-check` | `python tools/version.py check` | one version, one changelog section: the copies in `seide_cfg.h` and `shell/main.mjs` |
| `$(JSONTEST)` | `core/tests/test_json.c`, built against `json.o`/`buf.o`/`vec.o` | the JSON codec everything else trusts |
| — | `node langs/selftest.mjs` | 92 descriptor/tokenizer checks, both families, no kernel, no browser |
| — | `node subsystems/selftest.mjs` | 114 checks of the subsystem layer: the descriptor grammar and its rejections, the host's lifecycle (states, autostart, shared starts, failures, timeouts, stop-all, and a stop followed by a question), the channel seam, `words` completion and diagnostics incl. the tokenizer's quieting, the `lsp` adapter's framing helpers, and that adapter against a real child running `lsp-stub.mjs` — no kernel, no browser, no network |
| — | `node shell/web/selftest.mjs` | 130 checks of the protocol plumbing, board model (including the selection set, a group move/delete being one change each, and the frame's centre-inside membership and margin arithmetic), token spans, the editor's indent/find/replace arithmetic, the language client (which subsystem answers a capability, the prefix and ranking arithmetic, LSP ranges into line/column, diagnostics normalised from either shape, and that a shell with no subsystems is asked exactly once), the workspace search's line/column, excerpt and budget arithmetic, the undo ring and the wheel rule's arithmetic, the watcher's decision table (a clean card adopts, a dirty card is warned, an incomparable revision never reloads, one piece of news is reported once, and a kernel that answers `METHOD_NOT_FOUND` is trimmed rather than broken), and the classic view's roles and tile (the project panel wins the sidebar, the active editor holds the code area, hidden covers the rest, and the tile leaves no gap or overlap inside the viewport at four sizes), no DOM |
| — | `python tools/browser_smoke.py` | the window renders: HUD, workspace root, the board's first cards, the command bar |
| — | `python tools/input_smoke.py` | the board's input really is wired up: a double-click adds a card, Ctrl+Z takes it back, Ctrl+Shift+Z puts it back, a wheel over a card's own contents is left to the card while the board's own wheel still pans, the editor card's Tab, Shift+Tab, Enter, Ctrl+F, next-hit, replace-all, Escape and undo stack behave, Ctrl+Space opens a completion list the `lsp` subsystem answered and Enter takes one, a `TODO` and an unclosed `(` become issue rows whose click moves the caret there, and every exception the app throws is caught by the wrapper's own listeners and must be zero (a listener that throws changes no DOM node, so without that count a dead feature reads as an absent one), multi-select works — Ctrl+A selects every card, ctrl+click toggles one, a shift+drag band paints in world space, dragging one member moves the whole set by one delta, `select all` names the same set on the command line, and Delete plus one Ctrl+Z round-trips it — and `find <text>` lists real hits that open their file at their line, then frames every card with `group`, drags the frame and checks the cards standing in it moved by the same delta, and runs `ungroup` to check the frame goes and the cards stay, and finally writes a file out of band and then edits over it and deletes it, to check that an open card reloads a clean file, warns over a dirty one and reports the file that went away, and last runs `mode classic` to measure the tile as drawn (a tab strip under the HUD, a code area filling the right column, the sidebar the left, both ending on the board's bottom edge, every other card hidden), clicks a tab to check the code area moved to that file, wheels the code area and the strip to check the viewport did not move, and runs `mode board` to check every card, every size and the pan and zoom came back |

`smoke` runs the last two and needs a browser.  The release pipeline
(`tools/release.py`) runs `test` for every channel and adds `smoke` from beta
up; `docs/RELEASING.md` is the policy.

---

## Rejected alternatives, with reasons

- **Electron.** Rejected **in the base** because it means bundling a browser:
  hundreds of megabytes, a download in the build, and a Node-and-Chromium
  process tree. The prototype uses the system's Edge/Chromium in `--app=` mode
  with a throwaway profile instead. This is a prototype tradeoff, not a product
  answer; the product answer is WRY/Tauri (`docs/FORK.md`). A fork is a
  different question, and the answer there may be yes:
  `forks/electron-example/` wraps the same shell in an Electron window, with
  Electron in the fork's own `package.json` and nothing Electron-shaped in the
  kernel or the base shell. That is what keeping the dependency out of `main`
  means -- it is not a rule against anyone else using it.
- **A Rust kernel.** Dropped because a dependency's build script needed a C
  compiler, which breaks constraint 4 (fully offline, no configure step). C89
  has no build script and no dependency graph to resolve.
- **Language support in the kernel.** Rejected for the four reasons above.
- **A socket instead of stdio for `rpc` mode.** Rejected because stdio framing
  gives the shell a trivially correct lifetime rule: when the shell's stdin
  closes, the kernel exits and frees the app, which kills every live child.
  That is exactly the behaviour a closing window needs.
- **One reader thread per child process.** Rejected in favour of a single
  15 ms polling pump, to keep the kernel single-writer (see above).
- **Binary files as JSON strings.** `wksp` refuses to read a file containing a
  NUL byte ("file is binary") because shipping it as a JSON string would produce
  a document no client can round-trip.
- **A missing or corrupt view document.** Neither is the kernel's problem any
  more. An absent `.seide/board.json` is fine (first run: `document: null`,
  `revision: 0`), and a file that **exists but does not parse** is reported to
  the client by `view.load` -- the kernel does not open it at start-up at all.
  The earlier rule ("refuse to start rather than silently discard a user's
  layout") was reversed in `seide/2`, because the client is the thing that can
  tell a layout from a parse error, and a kernel that will not start is a worse
  outcome than a client that offers to rewrite the file. `docs/VIEWS.md` has the
  reasoning; `docs/BUGS.md` (entries N8, N10) has the two bugs that made the
  old rule expensive.
