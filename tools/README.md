# seIDE Python tooling

Standard-library-only helpers that sit beside the C kernel (`core/`) and the
JavaScript shell (`shell/`). Nothing here is required to run seIDE: these are
build, scaffolding, verification and reference tools.

| Tool | What it is for |
| --- | --- |
| [`bf.py`](bf.py) | Brainfuck interpreter and reference implementation of the `langs/brainfuck.lang` semantics. It is also what `e2e.py` uses to learn the expected output of a fixture, and what a `runner` card starts with `proc.start`. |
| [`newlang.py`](newlang.py) | Writes a `.lang` descriptor in the exact grammar `langs/lang.mjs` parses — flat by default, or an SGML-family member with `--family sgml` and repeatable `--raw-element NAME` (see `langs/README.md` for the grammar itself). |
| [`e2e.py`](e2e.py) | End-to-end protocol driver: spawns an endpoint, speaks newline-delimited JSON-RPC on its stdin/stdout, and asserts the frozen scenario. |
| [`kernel_probe.py`](kernel_probe.py) | The regression probe for every bug in `docs/BUGS.md`, plus the shapes `file.stat` promises: spawns the kernel against a scratch workspace under `build/` and asserts the safe outcome of each fix. `make probe`. |
| [`kernel_drive.py`](kernel_drive.py) | The stdio JSON-RPC harness `kernel_probe.py` runs on: starts `<seide> rpc --root DIR`, pumps both pipes on threads, and turns a silent method into `<silence>` instead of a hang. |
| [`seide_cli.py`](seide_cli.py) | The protocol's **second client**: `hello`, `info`, `ls`, `cat`, `write`, `board`, `run` and `selfcheck`, over the same stdio JSON-RPC, importing nothing from `shell/`. `board` prints the view document this client keeps (`.seide/board.json` unless `--path` says otherwise) and says so when it is not the board shape; `write` refuses to replace an existing file without `--base-revision` or `--force`; `run` opens a process with `proc.start`, writes its input, streams `proc.output` and exits with the child's code; `selfcheck` runs eight checks against a scratch workspace under `build/`. `make cli-check`. |
| [`browser_smoke.py`](browser_smoke.py) | The window, without a human: starts the host, drives the system browser headless (`--dump-dom`), and asserts on the rendered DOM — HUD, workspace root, painted board. Restores the view document byte-identically and kills the host by pid; with no document at all (a fresh clone) it installs `examples/board.json` for the run and removes it again. `make smoke`. |
| [`input_smoke.py`](input_smoke.py) | The input `--dump-dom` cannot drive: frames the real app in a temporary same-origin wrapper, double-clicks empty space to add a card, sends Ctrl+Z and Ctrl+Shift+Z and counts the cards — including that Ctrl+Z with a text field focused leaves the board alone — then dispatches a wheel over a card's own scroll region (the card must keep it) and over the board (the board must pan). It goes on to drive an editor card's own keys (Tab, Shift+Tab, Enter after an opener, Ctrl+F, next hit, replace-all, Escape, and that the textarea's undo still holds those edits), then Ctrl+Space to open a completion list the `lsp` subsystem answered and Enter to take one, then types a `TODO` and an unclosed parenthesis to check both arrive as issue rows whose click moves the caret, multi-select (Ctrl+A, ctrl+click, a shift+drag band, a group drag, `select all`, Delete plus one undo), `find <text>` and the hit row that opens its file at its line, and `group`/`ungroup` over a frame (the cards inside it move by the same delta, and stay when the frame goes), and finally writes a file out of band — as another program would — to check that the open card reloads a clean file, warns over a dirty one and reports a file that was deleted under it. Finally it types `mode classic` and measures the view in the board's own pixels — a tab strip under the HUD, a code area filling the right column and the sidebar the left, both ending on the board's bottom edge, every other card hidden — clicks a tab to check the code area moved to that file, wheels the code area and the strip to check the viewport did not move, and runs `mode board` to check every card, size, pan and zoom came back. The wrapper also installs `error`/`unhandledrejection` listeners on the app's window and reports the count, so a feature that threw inside a listener cannot pass as one that is simply idle. 37 checks. `make smoke`. |
| [`build.py`](build.py) | Thin wrapper around the repository `Makefile` (it never invents compiler flags); locates `mingw32-make`/`gcc` and reports them. |
| [`version.py`](version.py) | The one version: `show`, `check`, `set`, `bump`. `VERSION` is the source; the copies in `core/include/seide_cfg.h` and `shell/main.mjs` are written from it, and `check` also requires the top `##` section of `CHANGELOG.md` to be `## Unreleased` or `## v<version>`. Runs inside `make test`. |
| [`release.py`](release.py) | Cuts a release in five steps — preflight, verify, freeze the changelog, artifacts, tag — and refuses a dirty tree, the wrong branch, a taken tag, or a changelog that does not name this version. `--dry-run` prints the whole plan and writes nothing; `--fork NAME` releases `forks/NAME` instead. Policy in `docs/RELEASING.md`. |
| [`msi/build.py`](msi/build.py) | Expands the WiX v4 source for a staged bundle and calls `wix` to bind a per-machine installer. Deliberately not a build dependency: no WiX means one sentence and exit 2, never a fake `.msi`. 1.x only; never built here. |
| [`demo.py`](demo.py) | Installs `examples/board.json` — the five-card board in the README's screenshots — as this workspace's `.seide/board.json`. `.seide/` is gitignored, so a fresh clone otherwise opens an empty canvas, and every screenshot and bug report in the docs would be unreproducible. Refuses to overwrite an existing board without `--force`; `--print` shows the board and changes nothing. |

## Examples

**1. Run a Brainfuck program, with input and a tape dump**

```console
python tools/bf.py examples/hello.bf --input "hello" --dump-tape
```

**2. Scaffold a language descriptor (refuses to overwrite without `--force`)**

```console
python tools/newlang.py --id brainfuck --ext .bf --title Brainfuck --comment "#" --out langs
```

**3. Give a fresh clone the board in the screenshots** (the layout is per-checkout
state and is not committed, so a new clone starts with an empty canvas)

```console
python tools/demo.py                 # install into ./.seide/board.json
python tools/demo.py --root DIR      # ... into another workspace
python tools/demo.py --force         # replace a board you already have
python tools/demo.py --print         # print it, change nothing
```

**4. Prove the fixed bugs are still fixed** (46 checks, on its own scratch
workspace — it cannot touch your board — nine of them the promises `file.stat`
makes, which the shell's watcher reads on a timer)

```console
python tools/kernel_probe.py
```

**5. Check the window still paints** (needs a Chromium-family browser; says so
and exits 0 with a SKIP when there is none)

```console
python tools/browser_smoke.py
python tools/browser_smoke.py --edge "C:\path\to\msedge.exe" --keep
```

**6. Drive that window's input** (same browser requirement; the checks
`browser_smoke.py` cannot make, because `--dump-dom` drives no input)

```console
python tools/input_smoke.py
python tools/input_smoke.py --keep     # leave the wrapper page for a look
```

`make smoke` runs both.

**7. Verify a build end to end** (`--seide-cmd` takes the whole command line, so
the shell multiplexer can be driven too; the default `--seide` is the
kernel-only path and skips the `lang.*` checks)

```console
python tools/build.py core test
python tools/e2e.py --seide build/seide.exe --fixture examples/hello.bf
python tools/e2e.py --seide-cmd "node shell/main.mjs rpc --workspace ." --fixture examples/hello.bf
```

**8. Move the version, and prove every copy moved with it**

```console
python tools/version.py show            # 0.2.0-alpha.1, channel alpha
python tools/version.py bump            # alpha.1 -> alpha.2, in VERSION and both copies
python tools/version.py check           # exit 1 if a copy or the changelog disagrees
```

**9. See what the next release would do** (nothing is written, no suite runs)

```console
python tools/release.py --dry-run
python tools/release.py --dry-run --fork electron-example     # a fork's plan
```

Drop `--dry-run` to cut it for real; `docs/RELEASING.md` has the five steps,
the channel table and every rehearsal flag.

**10. Use a workspace from the shell, without the window** (the second consumer
of the frozen protocol; it imports nothing from `shell/`, and its own rails are
the protocol's — `write` wants the revision you last read)

```console
python tools/seide_cli.py hello
python tools/seide_cli.py ls "docs/*.md"
python tools/seide_cli.py cat README.md --meta
python tools/seide_cli.py board
python tools/seide_cli.py write notes.txt --text "hello\n"
python tools/seide_cli.py run "python tools/bf.py examples/hello.bf"
python tools/seide_cli.py selfcheck           # eight checks, scratch workspace
```

`make cli-check` runs the last one inside `make test`.

## Notes

* Exit codes are consistent across the tools: `0` success, `1` a check or the
  build failed, `2` a driver or environment error (endpoint not found,
  conflicting endpoints, protocol failure, file that cannot be written) and `3`
  a malformed command line. `bf.py` uses `2` for a program or parse error and
  `3` for a usage error. `version.py` and `release.py` keep the same ladder:
  `2` is a missing tool or a `VERSION` file that cannot be read, `3` a usage
  error, and `1` is what a release gate returns when it says no.
* `e2e.py` runs in **kernel mode** with `--seide` (spawns `<seide> rpc`; the
  kernel serves no `lang.*`, so those checks are reported as skipped) and in
  **full mode** with `--seide-cmd` (the command line is spawned verbatim, e.g.
  `node shell/main.mjs rpc --workspace .`; `lang.list`, `lang.tokenize` and the
  span-tiling assertion all run).
* `e2e.py` asserts fourteen things: the `hello` handshake, `workspace.info`, the
  language layer (`lang.list`, `lang.tokenize`, that its spans tile the file with
  no gaps or overlaps, and that an SGML file — `examples/page.html`, not the
  Brainfuck fixture — goes through the same path with its own kinds),
  `file.read`, `file.write` plus a stale `base_revision`, path containment
  (absolute and relative escapes refused with `1003`), the `view.save`/
  `view.load` round-trip, the shipped starter board (`examples/board.json`
  stored and read back member for member — the kernel does not judge the shape,
  so this is a storage check; the board schema's own check is
  `shell/web/selftest.mjs`), `proc.start` streamed to `proc.exit`, and the other
  half of that channel: `proc.send` reaching a child's stdin, `proc.close`
  ending it, and a send after the close refused with `1005`. Kernel mode skips
  the four language checks, so a green kernel
  run reads `10 passed, 0 failed, 4 skipped`; a green full run reads
  `14 passed, 0 failed, 0 skipped`. Both exit `0`.
* The revision checks have to *change* the file to move its revision, because a
  file revision is a content hash: they append a comment, then write the original
  bytes back, so a finished run leaves the fixture byte-identical (`sha256`
  checked). The restore runs from a `finally` block, so a failing check -- a
  concurrent edit moving the file under it, a killed endpoint between the two
  writes -- still puts the original bytes back instead of leaving the probe
  comment behind.
* The two document checks are snapshot-and-restore as well, of the whole document
  (`board_state()` / `board_restore()`): a suite that silently drops where the
  developer put the camera or which cards are open is testing the wrong product.
  Restoring goes back through `view.save`, so the result is the kernel's own
  serialisation; with the shipped starter board that is byte-identical (3107
  bytes measured), and the check reports semantics rather than bytes because the
  kernel, not the test, owns the formatting. `board_state()` decides for itself
  whether a file was there (`os.path.exists` on the absolute path) — the kernel's
  reply describes the document it holds, not the directory.
* Colour is disabled when stdout is not a TTY or when `NO_COLOR` is set.
