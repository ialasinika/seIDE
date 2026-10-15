# `subsystems/` — cross-process capability, deliberately outside the kernel

This directory is the *entire* subsystem layer of seIDE.  It is a sibling of
`langs/`, and of `core/` it is not a part.

The kernel knows about files, documents and processes.  It does not know what a
language server is, what a formatter is, or that completion exists — and it never
will.  A subsystem is:

| what | where | language |
| --- | --- | --- |
| a capability, declared | `subsystems/<id>.sub` | a text file, no code |
| how to read that file, and own a lifetime | `subsystems/host.mjs` | JavaScript, no dependencies |
| the built-in one | `subsystems/words.mjs` | JavaScript, no dependencies |
| a language server or other child | `subsystems/<id>.mjs` (to come) | JavaScript, no dependencies |

Consequences a fork can rely on:

- **Deletable.** `rm -rf subsystems/` leaves a kernel that still builds and a
  shell that still runs.  `subsystem.list` answers `{"subsystems":[]}` — the
  editor loses completion and diagnostics and nothing else.
- **Replaceable.** The wire contract is the four methods below.  Reimplement
  them in any language and delete this directory.
- **Data, not code, per subsystem.** A new capability is one `.sub` file plus
  one module.  The host, the shell and the protocol stay as they are, the way
  adding Brainfuck needed no change to the kernel.

## The descriptor grammar (frozen)

```
# seIDE subsystem descriptor
id words
title Words
kind builtin
module words.mjs
capabilities completion diagnostics
autostart yes
description completion from the words at hand, and syntax diagnostics
```

- A line whose **first byte** is `#` is a comment.  An indented `#` is not.
- One `key value` per line.  Blank lines are ignored.
- Keys: `id`, `title`, `kind`, `module`, `capabilities`, `autostart`, `launch`,
  `description`.
- **An unknown key is a hard error**, and so is an unknown capability or an
  unknown `kind`.  Silently ignoring a key the author believed in is how
  descriptors rot.
- `id` must be lowercase letters, digits or `-`, and the file must be named
  `<id>.sub`.
- `module` is a bare file name in this directory.
- `capabilities` may repeat, and one line may list several.  The list is closed:
  `completion`, `diagnostics`, `hover`, `definition`, `format`, `rename`,
  `debug`, `terminal`, `vcs`.
- `autostart` is `yes` or `no`.  The default is `yes` for a `builtin` and `no`
  for a `process`: starting a server is a decision, and running code that is
  already here is not.
- `launch` is a `process`-only line, passed to the adapter through the channel
  factory.  It is in the descriptor because "which server, with which flags" is
  data, not code.

## Wire contract

The host answers four methods.  They are served by the **shell**, not by the
kernel, exactly as `lang.*` is.

```
subsystem.list    {}                                    -> {"subsystems":[{"id","title","kind","capabilities","state"}, ...]}
subsystem.start   {"id", "params"?}                     -> {"id", "state"}
subsystem.stop    {"id"}                                -> {"id", "state"}
subsystem.request {"id", "method", "params"?}           -> whatever the subsystem answers
```

A subsystem's own methods are named after the capability they serve:
`complete`, `diagnose`, `hover`, `definition`, `format`, `rename`, and
dotted pairs such as `debug.launch` and `vcs.status`.  The host never looks
inside an answer; the shape of `complete`'s items is the *subsystem's* contract,
and a client that wants a different shape writes a different subsystem.

`state` is one of `stopped`, `starting`, `running`, `stopping`, `failed`.
`subsystem.list` always answers — for every descriptor, whether or not it can be
loaded — so a client can draw a settings page without waking anything.

Notifications, on the same stream as the kernel's:

```
subsystem.state  {"id", "state", "reason"?}      the lifecycle, as it happens
subsystem.output {"id", "stream", "text"}        a child's stdout or stderr
subsystem.log    {"id", "message"}               the host's own voice
```

Errors are the shell's, and never reach the kernel:

| code | name | when |
| --- | --- | --- |
| -32011 | `UNKNOWN_SUBSYSTEM` | no descriptor claims that `id` |
| -32012 | `SUBSYSTEM_FAILED` | it would not load, start, stop, or is not running and cannot autostart |
| -32013 | `SUBSYSTEM_TIMEOUT` | no answer within the host's patience limit (5 s) |
| -32014 | `SUBSYSTEM_UNSUPPORTED` | a `process` subsystem in a shell with no process channel |
| -32601 | `METHOD_NOT_FOUND` | the subsystem does not answer that method |
| -32602 | `INVALID_PARAMS` | a missing or wrongly typed `id`/`method` |

## Lifecycle

- Nothing starts until it is asked for: a subsystem nobody uses costs one parsed
  file.
- `subsystem.request` starts its subsystem first when the descriptor allows it,
  because a client asking a question is a client that wants the answer.
- Two callers asking at once share the first start, so a server is never spawned
  twice.
- A start that throws moves the subsystem to `failed` and reports why; the
  reason also travels in the `subsystem.state` notification.
- Stopping is the reverse, and the shell stops everything it started when it
  exits — a subsystem is not allowed to outlive the window that owns it.

## Where the process comes from

`host.mjs` answers questions; it does not spawn anything.  A `process`
subsystem is handed a **channel factory** by whoever owns child processes:

```js
const host = new SubsystemHost({
  descriptors: loadSubsystems(SUBSYSTEMS_DIR),
  spawn: (spec) => ({ write(text), onOutput(cb), onExit(cb), kill() }),
});
```

That is the one seam this layer deliberately leaves open.  A builtin needs no
process at all, and `words` — the subsystem that works on any file — is a
builtin on purpose: it is the fallback that exists when no server does.

Wiring the factory to the kernel's duplex child-process channel (`proc.*`, issue
tracked as the "A/B" decision in the goal notes) changes nothing above this
line: same descriptors, same four methods, same states.  Until then a `process`
subsystem fails fast with `SUBSYSTEM_UNSUPPORTED` and says why, rather than
pretending to run.

## The built-in: `words`

`words.mjs` is the only subsystem that ships, and it needs no server, no
network and no configuration.

```
complete {"path"?, "text", "offset", "words"?, "limit"?}  -> {"prefix", "items":[{"label","kind","detail"}], "total", "truncated"}
diagnose {"path"?, "text", "lang"?, "limit"?}             -> {"diagnostics":[{"start","end","severity","code","message"}], "total", "truncated"}
```

Completion offers the identifiers of the document in front of it, plus any
`words` the client gathered from open cards, ranked by prefix, then use, then
length.  Every item says where it came from (`in this file` / `in this
project`).  It is word completion, not understanding: no keyword table, no
grammar, no file extension is consulted.

Diagnostics are three rules that can be proved from the text alone: brackets
that never close, close the wrong one or close nothing; a `/*` with no `*/`; and
a line with an odd number of quotes.  When `langs/` is present the tokenizer is
used to keep quiet — a bracket inside a comment or a string literal is not a
bracket — and when it has been deleted the same rules run on raw text.

## Test

```
node subsystems/selftest.mjs
```

97 checks covering the descriptor grammar and its rejections, directory
loading, the whole lifecycle (states, autostart, shared starts, failures,
timeouts, stop-all), the channel seam, `words` completion and diagnostics
(including the tokenizer's quieting), and the host's independence from the
kernel.  It needs no kernel, no shell, no browser and no network.
