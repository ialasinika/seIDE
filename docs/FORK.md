# Fork playbook

You are forking seIDE into your own IDE. This is the order of work, cheapest
first, with what each step touches and what it costs.

Read `docs/TRIM.md` first if you have not: trimming is step 2 and it is the
easiest step. Read `docs/PROTOCOL.md` before changing anything that crosses the
wire — the protocol is the seam that lets you replace every layer in any order.

---

## Before you change anything

Three things make the rest of this document work:

1. **The kernel is C89 and the compiler enforces it.** `-std=c89 -pedantic
   -Wall -Wextra -Werror`. C++ comments, declarations after statements,
   `long long` and variadic macros are compile errors, not warnings. Do not
   fight this; it is what keeps the kernel portable.
2. **stdout is protocol-only.** If you add a `printf` for debugging, it breaks
   the parser of every client. Use stderr.
3. **The kernel does not know about languages, and the board does not know about
   card semantics.** Keeping those two facts true is what keeps the code base
   small enough to fork.

---

## 1. Rename the product

Cheapest step. The name appears in these places:

| where | what |
| --- | --- |
| `README.md` | the title and all prose |
| `Makefile` | `BIN = build/seide.exe` (and `OBJDIR`) |
| `core/include/seide_cfg.h` | `SDE_VERSION`, `SDE_PROTOCOL` |
| `core/src/main.c` | `SDE_VERSION`, `usage()`, `cmd_modules()`'s banner |
| `shell/main.mjs` | `SHELL_VERSION`, the `USAGE` text, `DEFAULT_KERNEL`'s path |
| `shell/web/index.html` | `<title>`, `.hud-brand` |
| `shell/web/cards.mjs` | `COMMAND_HELP` if it names the product |
| `tools/*.py`, `tools/README.md` | banners and the `--seide` / `--seide-cmd` flags |
| `.gitignore` | if you rename `.seide/` |

Two traps:

- The board path is **not** a kernel constant any more: `shell/web/board.mjs`
  owns `BOARD_PATH` (`.seide/board.json`) and names it on every call, so a fork
  renames it in one place. `tools/e2e.py` spawns `<binary> rpc`; if you rename
  the executable, update the shell's `DEFAULT_KERNEL` **and** every documented
  command.
- The function and type names (`sde_*`, `SDE_*`) do **not** need renaming. They
  are internal; a fork that renames them buys nothing but a large diff.

**Cost:** an hour and a lot of find-and-replace. No risk to behaviour.

---

## 2. Delete what you do not want

`build/seide.exe modules` prints the trim manifest. `docs/TRIM.md` describes the
four edits (the file under `core/`, the `SRC` line in `Makefile`, the module
table in `core/src/main.c`, the method in `core/src/rpc.c`) plus the
compile-time switches in `core/include/seide_cfg.h`.

The cuts a fork usually makes first, in ascending order of pain:

| cut | effort | what you lose |
| --- | --- | --- |
| `langs/` (the whole language layer) | `rm -rf langs/`; the shell falls back automatically | colouring; the editor renders plain text |
| `proc` | 4 edits + `app.c` | `runner` cards, `proc.*` methods and every process subsystem |
| `view` | 4 edits + `app.c` + heavy shell changes | persistence of the layout — and with it the ability to keep any document at all |
| `wksp` | 4 edits + the `editor`, `search`, `files` and `project` card kinds | files; the canvas alone remains |
| `serve` | 4 edits + the `rpc` subcommand | any way into the process |

**Cost:** proportional to what you cut; the reverse — adding a module back — is
always harder than leaving it in. Cut last, not first.

One **method** can go without cutting a module: `file.stat` is one handler
(`h_file_stat`) plus one row in `sde_methods[]`, and the app's only consumer is
the shell's watcher, which stops polling on the first `-32601 METHOD_NOT_FOUND`
and logs that once rather than asking a question the kernel cannot answer. The
shipped tests still measure the kernel this repository ships, so `make probe`
(and the watch checks in `make smoke`) will say so — which is the point of
having them.

The **classic view** is a shell-level cut of the same kind, and it is mechanical
for the reason it exists: it never wrote to the document. `shell/web/classic.mjs`
is one pure module imported only by `main.mjs`; the rest of the cut is the
`mode` row and its `COMMAND_HELP` line in `shell/web/cards.mjs`, the classic
branches in `renderStage`/`renderCards`/`renderHud` plus `renderTabs`/
`renderSideHint`/`installView`, the `#tabs` and `#mode-toggle` elements in
`index.html` and their rules in `style.css`. No `board.json` changes and no card
loses a field, because the view was drawn from the board and saved nowhere —
which is the whole reason a fork can throw it away.

---

## 3. Replace the platform layer to leave Win32

The kernel's Windows dependency is **entirely** inside `core/port/`:

- `core/port/sys_win32.c` — files, paths, directories, mutexes, threads,
  time, stdout/stderr, `sde_port_startup`.
- `core/port/proc_win32.c` — child processes with two pipes and a
  non-blocking read.

The contract is `core/include/port.h`, which is 154 lines and uses opaque structs
and function pointers deliberately ("a fork may swap the implementation without
recompiling its callers"). The header states the invariant a new implementation
must honour:

> Paths handed across this API always use `/` as the separator. The Win32
> implementation accepts both on input and normalises internally.

To port:

1. Copy `core/port/sys_win32.c` and `proc_win32.c` to `sys_<name>.c` /
   `proc_<name>.c` and reimplement the bodies against your platform.
2. Change the `SRC +=` line in the `Makefile` — this is the only place the
   platform is selected, and the Makefile says so in a comment.
3. Add the platform switch in `core/include/seide_cfg.h`, which already carries
   the shape:

   ```c
   #if defined(_WIN32)
   #define SDE_PLATFORM_WIN32 1
   #else
   #define SDE_PLATFORM_POSIX 1
   #endif
   ```

4. Remove the two lines in `seide_cfg.h` that exist only for MinGW
   (`__USE_MINGW_ANSI_STDIO`, `_WIN32_WINNT`) from your platform's path, and
   remove `#include <windows.h>` from the implementation.

The five functions that most often get a port wrong, in the order they bite:

| function | the thing that matters |
| --- | --- |
| `sde_proc_start` / `sde_proc_read` / `sde_proc_kill` | a real two-pipe spawn with a **non-blocking** read (`>0` bytes, `0` nothing pending, `-1` exited and drained) |
| `sde_port_replace_file` | an atomic replace; a truncated board is a corrupted project |
| `sde_port_path_norm` / `sde_port_path_within` | containment must be lexical and correct (`..` escapes) |
| `sde_proc_write` / `sde_proc_close_input` | the write half of the channel: a queued write that never blocks the request loop |
| `sde_mutex_*` / `sde_thread_*` | the proc pump thread and the stdin writer are real; a stub `mutex` that does nothing is a data race on stdout |
| `sde_port_startup` | binary mode on the protocol streams and non-inheritable standard handles, so a child cannot keep the shell's pipes open after the kernel exits |

**Cost:** a day for POSIX, more if you also need `proc`'s process-tree kill
semantics. Nothing above `core/port/` changes — that is the whole point of the
layer, and it is stated in both `port.h` and the `Makefile`.

---

## 4. Add a card kind

`kind` is an open string: the kernel's *validation* accepts any non-empty value
and stores it verbatim, and the board model clones whatever fields you attach.
So a new kind is purely a shell change, and mostly a single registration:

1. `shell/web/cards.mjs` — one call:

   ```js
   registerCardKind({
     kind: "waveform",
     title: "Waveform",
     create: () => ({ samples: [] }),
     describe: (card) => `waveform ${card.samples.length} samples`,
     render: (card, ctx) => { /* -> {el, handle, destroy} */ },
   });
   ```

   `render` receives `ctx = {client, app}`, so **a card never talks to the kernel
   directly** — it goes through `ctx.app`, which is what keeps cards testable and
   keeps the kernel reachable from exactly one place. The registry contract, the
   shared chrome (`cardShell`/`h`) and a worked 400-line example live in
   [`SURFACES.md`](SURFACES.md).
2. `shell/web/board.mjs` — add the kind to `CARD_KINDS` (documentation only) and
   give it a default in `DEFAULT_SIZE` so a new card is not 0x0.
3. `shell/web/main.mjs` — if the kind needs a command-line verb, add a `case` to
   the command switch (copy the `sheet` case) and a row to `COMMAND_HELP`.
4. `shell/web/style.css` — the card shell (`.card`, `.card-title`, `.card-kind`,
   `.card-label`, `.card-tools`, `.card-grip`) is already styled; add your own
   kind's styles under a `.card-body-<kind>` class.

An unknown `kind` is not fatal even before you write the renderer: `renderCard`
falls through to a placeholder that says the card is preserved in `board.json`
and lists the kinds that build knows. That placeholder is your scaffold.

If the kind needs a new kernel capability, add a method to `rpc.c`'s table —
and accept that you have just coupled the kernel to a feature. The five shipped
kinds between them need nine kernel methods; five of them are generic file and
process verbs. A `sheet`-like structured surface needs **no** kernel method at
all, because the kernel stores its payload verbatim.

**Cost:** hours for a self-contained kind (a `note`-like card is ~60 lines), days
if it needs new kernel verbs.

---

## 5. Add a language

Languages are data, not code. `langs/README.md` freezes the grammar and the two
wire methods. Three ways, in order of preference:

**Write the descriptor** — a text file, `langs/<id>.lang`:

```sh
python tools/newlang.py --id mylang --ext .ml --keywords "if,else,while" --comment "#" --out langs
```

`--keywords` splits on commas (repeatable), so a token that *is* a comma needs
the single-token spelling:

```sh
python tools/newlang.py --id brainfuck --ext .bf \
    --keywords "+,-,<,>,[,],." --keyword ","
```

Syntax that is SGML's rather than one language's — HTML, XML, SVG — is scaffolded
as a *family* member instead. Its delimiters are the engine in
`langs/markup.mjs`, so the descriptor names only its id, extensions and the
elements whose body is raw text:

```sh
python tools/newlang.py --id html --ext .html --family sgml \
    --raw-element script --raw-element style --out langs
```

`--comment`/`--keywords`/`--keyword` are flat-scan facts and are refused with
`--family sgml`; `--raw-element` is refused without it.

The generated flat descriptor follows the frozen grammar in `docs/PROTOCOL.md`
(`# seIDE language descriptor`, `id`, `title`, `ext`, optional `line_comment` /
`block_comment_open` / `block_comment_close` / `string`, and
`kind <kindname> "<token>" ...`). An unknown key or an unquoted token is a hard
error — `parseDescriptor` throws `LangError` with `source` and a 1-based `line`,
so you will know exactly where you went wrong.

**Check it** with the language self-test, which needs no kernel and no browser:

```sh
node langs/selftest.mjs
```

**Replace the layer entirely** if descriptors are too weak. `lang.list` and
`lang.tokenize` are answered by the shell, so a fork can reimplement them in any
language — including a real parser with a real type system — and delete
`langs/`. The only constants are the two method shapes and the tiling guarantee
of `lang.tokenize` (spans cover `0..text.length` exactly once, in order).
`text.length` is a JavaScript string length, so the wire speaks **string
indices** (UTF-16 code units), not byte offsets: `langs/tokenize.mjs` scans a
JavaScript string and returns indices into it, and both selftests pin that with
non-ASCII fixtures. A replacement tokenizer written in another language has to
convert if it counts bytes or code points.

**Cost:** ten minutes per language for colouring; weeks if you are building real
language intelligence, and in that case you are reimplementing the two methods
rather than extending them.

---

## 6. Move the transport off stdio

The transport is deliberately the thinnest thing in the project.

- **Kernel side:** `core/src/serve.c` is the stdio reader/writer. `serve.h`
  states the contract and the invitation:

  > replace `sde_serve` with a socket loop and nothing above it changes.

  The two constraints to keep are (a) one JSON object per frame, and (b) one
  writer at a time — the output mutex exists because the proc pump thread and
  the request loop both emit.

- **Shell side:** `shell/main.mjs`'s `Kernel` class spawns `<binary> rpc --root
  <workspace>` and speaks the same frames over pipes. It already generates its
  own request ids (`h<N>`) and matches replies by id, so replacing pipes with a
  socket means changing `Kernel` and the `spawn` arguments, not the rest of the
  shell.

- **HTTP/SSE, if you want it:** the `serve` mode already multiplexes frames over
  `POST /rpc` and fans notifications out over `GET /events`. That is a working
  example of a non-stdio transport that did not require touching the kernel.

**Cost:** hours for a straight swap (stdio → named pipe → unix socket → TCP).
Real work only appears when you need authentication or more than one client,
because the kernel answers one frame at a time and has no per-client session
concept at all.

---

## 7. Ship a real window with WRY/Tauri

The prototype's window is the system's Edge/Chromium in app mode, launched by
`openWindow()` in `shell/main.mjs` with a throwaway profile:

```
--app=<url> --user-data-dir=<temp> --no-first-run --no-default-browser-check
--disable-features=Translate
```

That is a prototype decision, not a product answer: the window is a browser
window with the chrome on, it takes no part in window management, and it cannot
receive from the OS. **For a real product the replacement path is WRY/Tauri** —
a Rust webview host that uses the OS's own webview (WebView2 on Windows,
WebKit elsewhere) instead of bundling a browser.

The repository contains **no WRY or Tauri code today**; the path is described
here, not implemented, and this section deliberately specifies interfaces rather
than inventing a source file.

What a WRY host must provide, in terms of what exists now:

1. **Keep the HTTP server and the kernel link as they are.** The existing
   `serve` mode's static serving + `POST /rpc` + `GET /events` is a complete
   backend for a webview. WRY loads a URL, so point it at the same
   `http://127.0.0.1:<port>` the shell already serves.
2. **Replace only `openWindow()`.** Use port 0 so the OS picks a free port
   (already the default), learn the chosen port, then create the WRY window
   pointing at that URL. The shell's `server` currently binds port 0 and the
   chosen port is what gets printed and launched.
3. **Own the lifetime.** Today the shell exits when the browser process exits
   (`browser.once("exit", ...)` calls `shutdown()`, which closes the kernel and
   the port). A native window has an equivalent close event; wire the same
   shutdown to it, or the kernel and its child processes outlive the window.
4. **Move the front end or keep the web UI.** The web UI can stay: WRY hosts a
   webview, so `shell/web/` runs unmodified. Rewriting the UI natively is a
   separate, much larger decision and would discard `board.mjs` and `cards.mjs`,
   which are the parts with no obvious native equivalent.
5. **Consider the notification rate.** The kernel emits a `proc.output`
   notification per 8192 bytes per 15 ms pass, and the shell forwards each one
   over SSE. A webview's IPC is heavier than a browser's; a native host may want
   to coalesce output frames before injecting them. (Nothing in the repository
   coalesces today.)

**Cost:** the highest of the seven steps. It adds a Rust toolchain to a project
whose defining constraint is that the build is fully offline with no package
manager — a WRY/Tauri host brings a `Cargo.toml`, a dependency graph and a
network fetch into CI. If constraint 4 matters to you more than the window
chrome does, this is the step you skip; if the window is the product, this is
the step you do first and the rest of the prototype becomes your backend.

**A cheaper window, if not a native one:** [`forks/electron-example/`](../forks/electron-example/README.md)
is the smallest version of this move.  The shell runs unmodified, Electron draws
the window, `contextIsolation` and `sandbox` stay on, and the dependency lives in
the fork's own `package.json` -- so the base repository stays dependency-free and
the fork still ships a real window.

---

## Which of these cost what

| step | files touched | effort | risk | keeps constraint 4? |
| --- | --- | --- | --- | --- |
| 1. Rename | docs, 5 source files, 4 tool files | 1 hour | low | yes |
| 2. Trim | `core/`, `Makefile`, `main.c`, `rpc.c` | hours | low | yes |
| 3. Port the platform layer | `core/port/*`, `Makefile`, `seide_cfg.h` | 1 day+ | medium (spawn, atomic replace, threads) | yes |
| 4. Add a card kind | `shell/web/board.mjs`, `cards.mjs`, `main.mjs`, `style.css` | hours | low | yes |
| 5. Add a language | `langs/<id>.lang` | 10 minutes | very low | yes |
| 6. Move the transport | `core/src/serve.c` or `shell/main.mjs` | hours | low if framing and single-writer are preserved | yes |
| 7. WRY/Tauri window | `shell/main.mjs` + a new Rust host | days | high | **no** — adds a dependency graph and a fetch |

---

## What a fork may put in a release

Everything above changes the source you build.  A fork that wants to be *shipped*
-- shipped by this repository's own machinery, under its own name and its own
tag -- adds two things and nothing else:

```
forks/<name>/fork.json      {"name": "...", "title": "...", "summary": "..."}
forks/<name>/files/...      copied over the bundle root, file for file
```

```sh
python tools/release.py --fork <name> --dry-run    # the plan
python tools/release.py --fork <name>              # a 1.x channel, in practice
```

The fork then gets `<name>-v<version>` as its tag, its own release directory, a
bundle with `files/` laid over the bundle root, and `<name>-fork.zip` -- the
fork's whole delta, kept under `forks/<name>/` the way the base tree keeps it,
plus an `APPLY.md`.  `fork.json` can set
`"no_fork_zip": true` for a fork that only exists as an overlay.

Two rules make this work.  **The overlay is `files/`**: a fork does not patch
base files in place through the pipeline, it replaces them, so what a fork has
changed is always a short list.  **The dependency belongs to the fork**: if a
fork needs Electron, a Rust host, a UI framework or a package manager, it says
so in its own `package.json` (or its own `Cargo.toml`), never in the base tree.
That is what keeps constraint 4 true for everyone who does not want the fork.

[`forks/electron-example/`](../forks/electron-example/README.md) is the worked
example: an Electron window around the same shell, with Electron in the fork's
own `package.json` and no Electron anywhere in `main`.  It has never been built
in this checkout -- no network, no dependencies -- and says so itself.
[`docs/RELEASING.md`](RELEASING.md) is the release policy the pipeline follows.

---

## Ideas the prototype leaves on the table

Not implemented, not promised, and each cheap enough to be tempting.  (Undo used
to head this list; it is built now — `shell/web/history.mjs`, `Ctrl+Z` — so what
follows is what is genuinely still missing:)

- **A conventional IDE layout on top of the board.** Built now, as a projection:
  `mode classic` (one pure module, `shell/web/classic.mjs`) draws the same cards
  as a code area, a tab strip and a sidebar without creating, moving or saving
  anything. Still on the table, and each of these would need something the
  projection deliberately refuses: split panes, a sidebar you drag to resize, a
  per-tab close (a card has no close), tab reordering, remembering the mode in
  `board.json`, and a `files`/`project` sidebar that behaves like a tree rather
  than like the card it is.
- **A minimap or "fit board to window".** The viewport is three numbers; the
  cards are a flat list with geometry. This is a shell-only feature.
- **More than one kind of multi-select.** Multi-select itself is built — Ctrl+A,
  ctrl/shift-click, a shift+drag rubber band, group move and group delete, with
  the set held in `board.mjs` and a primary member for single-card verbs — but
  the rubber band is the only geometric selector: no lasso over links, no
  "select every card of this kind", no field edit across a selection.
- **Frames that do more than move.** A `frame` moves the cards whose centre
  stands inside it (`group`/`ungroup`), which is enough to carry a cluster
  around the board without storing a membership list. Still on the table: a
  frame that clips its contents, folds them away, lays them out in a row or a
  grid, or nests inside another frame.
- **Links with semantics.** A `from`/`to` pair plus a label is already in the
  document; nothing consumes them. A "run the card this link points at" verb is
  a shell feature over existing methods.
- **Find across the workspace.** Built now — the `search` card and the `find
  <text>` verb, over `workspace.list` plus `file.read`, with no new kernel verb.
  What is still on the table here: regex mode, a search narrowed to a selection
  or to a glob the card cannot express, replace across files, and incremental
  results while you type.
- **A workspace that follows the disk.** Built now, in the narrow direction: the
  files open in `editor` cards are polled through `file.stat` (`shell/web/watch.mjs`,
  once every 1.5 s) so a clean card reloads, a card with unsaved edits is warned
  instead of overwritten, and a deleted file is reported. Still on the table:
  watching the **workspace** — so that `search`, `files` and `project` cards could
  refresh themselves and a stale search row would stop naming a line that moved —
  and having the *kernel* watch (`ReadDirectoryChangesW`, `inotify`) instead of
  the shell asking on a timer, which is a promise `docs/PROTOCOL.md` deliberately
  does not make.
- **A second client.** Built now, in the cheap direction: `tools/seide_cli.py` is
  a command-line consumer of `docs/PROTOCOL.md` (read, write, list, run, board)
  that imports nothing from `shell/`, with its eight checks in `make test` as
  `cli-check`. What that does *not* cover: it speaks to the kernel endpoint only,
  so the shell's additions (`lang.*`, HTTP + SSE) still have exactly one
  consumer — a second client for those, or an editor plugin, remains on the
  table.
