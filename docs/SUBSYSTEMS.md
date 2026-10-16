# Subsystems — capability outside the kernel

An editor is not a text box; it is a text box plus everything a programmer
expects around it: completion, diagnostics, hover, a definition jump, a
formatter, a debugger, a terminal, version control. The question this document
answers is where those live when the kernel is deliberately small.

The answer is a layer: `subsystems/`, a sibling of `langs/`, owned by the
**shell**. The kernel's part in it is one primitive — a child process it can
write to as well as read from — and not one line of capability.

```
client (shell/web)        asks "complete this", "diagnose this"
      |  subsystem.request
shell/main.mjs            one JSON-RPC endpoint; serves subsystem.* itself
      |  host.mjs
subsystems/<id>.sub      data: which capability, which module, autostart?
subsystems/<id>.mjs      code: the adapter, or the built-in
      |  spawn(spec)   <- the seam; the kernel's duplex channel plugs in here
child process (a language server, a formatter, a debugger)
```

## The three parts

| part | file | what it is |
| --- | --- | --- |
| declaration | `subsystems/<id>.sub` | a text file: id, title, kind, module, capabilities, autostart |
| host | `subsystems/host.mjs` | descriptors, lifecycle, request routing, timeouts, one channel seam |
| implementation | `subsystems/<id>.mjs` | `create(context)` returning `start`/`stop`/`request` |

Nothing about a capability reaches `core/`: not its name, not its methods, not
its errors. `seide modules` never lists it, `docs/PROTOCOL.md` never mentions
it, and `rm -rf subsystems/` leaves a kernel that still builds and a shell that
still runs — with `subsystem.list` answering `{"subsystems":[]}`.

## Why this is not the plugin system constraint 3 refuses

README constraint 3 says there is no plugin system, by design, and that is still
true. A plugin system is an *interface to code the project does not control*:
a stable API for strangers, a loader, a sandbox question, a support promise.
A subsystem is none of those:

- **It is source, not a package.** A descriptor and its module live in this
  repository and are reviewed, built and tested with the rest of it. Nothing
  downloads, registers or resolves a subsystem at run time.
- **There is no API stability promise to a third party.** The wire contract in
  `subsystems/README.md` is frozen for *this* client and *this* kernel — the
  same way `lang.*` is — not as a public extension surface.
- **There is no sandbox and none is claimed.** A subsystem is a child process or
  a module with the same privileges as the shell. A fork that wants to host
  untrusted code has a larger problem than this layer solves.
- **It is deletable.** The point of the layer is that capability can be added
  and removed without touching the kernel, not that strangers can add it.

What it *is*: an internal seam with a frozen wire, so that a capability the
editor gains tomorrow — and a capability a fork removes — never becomes a method
the kernel has to know about.

## The wire

Served by the shell, never forwarded to the kernel:

```
subsystem.list    {}                                    -> {"subsystems":[{id,title,kind,capabilities,state}, ...]}
subsystem.start   {"id", "params"?}                     -> {"id", "state"}
subsystem.stop    {"id"}                                -> {"id", "state"}
subsystem.request {"id", "method", "params"?}           -> whatever the subsystem answers
```

plus three notifications on the same stream as the kernel's — `subsystem.state`
(the lifecycle), `subsystem.output` (a child's stdout/stderr) and
`subsystem.log` (the host's own voice). States, error codes, the descriptor
grammar and every rule of the lifecycle are specified in
[`subsystems/README.md`](../subsystems/README.md); that file is the contract.

A subsystem's own method names follow the capability they serve: `complete`,
`diagnose`, `hover`, `definition`, `format`, `rename`, `debug.launch`,
`vcs.status`. The host does not inspect an answer, so the shape of a completion
list is the subsystem's business — a client that wants another shape writes
another subsystem.

## The seam: where the process comes from

The host owns *lifetimes*, not *processes*. A `process` subsystem is handed a
channel factory by whoever owns child processes, and that is the kernel:
`subsystems/host.mjs` is constructed with `spawn: (spec) => procs.open(spec)`,
where `procs` is the shell's `ProcChannels` over the kernel's `proc.*` methods.
A `builtin` subsystem needs no process at all, and the first one — `words` — is
a builtin on purpose, because it is what remains when no server exists.

The seam is one function:

```js
spawn({ subsystem, command, cwd, env }) -> { write(text), onOutput(cb), onExit(cb), kill() }
```

Which is exactly the kernel's contract: `proc.start` gives a run id,
`proc.send` writes to the child, `proc.close` closes its input, `proc.stop`
kills it, and `proc.output` / `proc.exit` are the callbacks. The path is

    host → spawn(spec) → shell ProcChannels → proc.start/send/close/stop
         → kernel proc module → WriteFile / reader threads → the server

so a subsystem is a *process* and the kernel never learns what a language server
is. `core/include/proc.h` states the one promise the kernel makes: a duplex
channel, at most 64 runs, and an output stream that is never allowed to block
the request loop.

`proc.*` exists because of this seam and for no other reason: the same five
methods run a `runner` card. See `docs/PROTOCOL.md` for the wire and
`core/port/proc_win32.c` for the pipes.

## What exists today

Built and tested: the descriptor grammar and its rejections, the host (states,
autostart, shared starts, failures, timeouts, stop-all), the four wire methods
with notifications, the `words` builtin (word completion and three provable
diagnostics, quieted by the tokenizer when `langs/` is present), the `lsp`
adapter with a scripted server behind it, and the kernel's duplex channel. The
suites are `node subsystems/selftest.mjs` (114 checks, no kernel, no browser, no
network, including a real child running `lsp-stub.mjs`), `node shell/web/selftest.mjs`
(130 checks of the client's language layer against fake channels) and `make test`,
which drives the same descriptor through the shell and the real kernel.

The `lsp` descriptor is pointed at the stub by default:

```
launch node "{here}/lsp-stub.mjs"
```

Replacing that line with `launch rust-analyzer` is the whole change; the wire
code does not know what a Rust file is. The stub exists so the adapter has a
server whose answers are predictable, not because no real one could be run.

A real one was run: `python-lsp-server` (`pylsp`), installed into
`build/probe-tmp/pylsp` so nothing on this machine changed, answered through this
same adapter over a real Python file -- `import` after typing `\nimpor`, a
signature on hover, `def norm`'s line for a definition, and pyflakes' three
complaints about a file with an unused import, an unused variable and an
undefined name. Doing that found a real defect (a stopped subsystem could not be
started again; `docs/BUGS.md`, N14) that the scripted server had hidden, which is
the argument for testing against something that was not written to agree with
you. `rust-analyzer` is *not* on this machine: `rust-analyzer.exe` in
`~/.cargo/bin` is a rustup shim and the component is missing from both installed
toolchains, so the Rust descriptor would need `rustup component add
rust-analyzer` (or a different server) before it could run.

The client side exists too: the editor card asks for completions on `^Space`
(with `Enter`/arrows, and the answer's source named in the status line), shows
diagnostics in an issue strip that a click jumps to, and answers `^I` (hover),
`F12` (definition) and `^.` / `^⇧.` (next and previous issue). `python
tools/input_smoke.py` is the
proof it works in a real browser: it types at a real card and reads the rows
back, over the kernel's own channel, with no server installed.

Terminal, debugger and version control are the same shape as `lsp`: a
descriptor, an adapter, and nothing new in the kernel or in this document.

## See also

- [`subsystems/README.md`](../subsystems/README.md) — the frozen contract.
- [`docs/VIEWS.md`](VIEWS.md) — the same argument for the document the kernel
  stores: it defines that a view exists, not what one is.
- [`langs/README.md`](../langs/README.md) — the layer this one is modelled on.
- [`docs/PROTOCOL.md`](PROTOCOL.md) — the kernel's method table, which contains
  no subsystem.
