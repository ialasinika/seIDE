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
channel factory by whoever owns child processes today, and today that is
nobody: the shell constructs `SubsystemHost` without `spawn`, so a `process`
descriptor fails fast with `SUBSYSTEM_UNSUPPORTED` and a sentence explaining
why. A `builtin` subsystem needs no process at all, and the first one — `words`
— is a builtin on purpose, because it is what remains when no server exists.

Wiring the factory is one code path with two candidates:

- **A. the kernel's duplex channel.** `core/` already owns child processes
  (`core/include/exec.h`, `core/src/exec.c`), but the pipe is read-only: stdin
  goes to the NUL device so a runner can never eat the protocol stream. The
  work is to make it duplex (`proc.open/send/close/list`, one `WriteFile`-safe
  write path per channel) and to rename the runner-shaped vocabulary to a
  process-shaped one. This keeps the promise `core/include/exec.h` already
  makes — the kernel owns child processes so the shell does not have to — and
  it is the only option that lets a non-shell client use subsystems.
- **B. the shell spawns children itself.** Zero kernel change, a smaller diff,
  but two owners of child processes in one program, and only clients that speak
  to the shell can use a subsystem.

Nothing above this line changes either way: same descriptors, same four
methods, same states, same error codes. That is the point of putting the seam
there.

## What exists today

Built and tested: the descriptor grammar and its rejections, the host (states,
autostart, shared starts, failures, timeouts, stop-all), the four wire methods
with notifications, the `words` builtin (word completion and three provable
diagnostics, quieted by the tokenizer when `langs/` is present), and
`node subsystems/selftest.mjs` — 97 checks, no kernel, no browser, no network.

Not built yet, in the order they matter: the process seam (A or B above), an
`lsp` subsystem (a real language server behind the same four methods), and the
client side — a completion popup, diagnostics in the gutter, hover, go-to
definition, and in-file find/replace — which is the largest of the three and
the one a user actually sees.

Terminal, debugger and version control are the same shape as `lsp`: a
descriptor, an adapter, and nothing new in the kernel or in this document.

## See also

- [`subsystems/README.md`](../subsystems/README.md) — the frozen contract.
- [`docs/VIEWS.md`](VIEWS.md) — the same argument for the document the kernel
  stores: it defines that a view exists, not what one is.
- [`langs/README.md`](../langs/README.md) — the layer this one is modelled on.
- [`docs/PROTOCOL.md`](PROTOCOL.md) — the kernel's method table, which contains
  no subsystem.
