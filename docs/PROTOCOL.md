# Protocol

The wire contract between a client and seIDE. There are two endpoints and one
frame format; this document is the frozen reference for both.

- **Kernel endpoint** — `build/seide.exe rpc`. Answers the eleven methods in the
  table below. Knows nothing about languages.
- **Shell endpoint** — `node shell/main.mjs rpc` (stdio) or
  `node shell/main.mjs serve` (HTTP + SSE). Forwards every kernel method, adds
  the `langs` member to `workspace.info`, and answers `lang.list` and
  `lang.tokenize` itself.

A client that only needs files, documents and processes can target the kernel
endpoint directly. A client that wants colouring should target the shell.

Two clients exist today: the view in `shell/web/` (a board) and the command-line
client `tools/seide_cli.py`. The second one is there so this document has to
stand on its own -- see [A second client](#a-second-client).

---

## Framing

Frames are **one JSON object per line**, delimited by `\n`, in both directions.
Leading and trailing whitespace on a line is trimmed; a blank line is a
keep-alive and is ignored. The kernel reads a frame at a time and writes one
response line per request line.

The single-frame cap is 64 MiB. An oversized frame is **reported and dropped
rather than fatal** — the reader discards bytes up to the next `\n` and emits:

```json
{"event":"log","message":"frame too large; dropped"}
```

**stdout is protocol-only.** Every diagnostic goes to stderr, so a client can
treat every stdout line as exactly one frame. Breaking this rule desynchronises
the reader permanently.

### Request

```json
{"jsonrpc":"2.0","id":1,"method":"file.read","params":{"path":"examples/hello.bf"}}
```

- `jsonrpc` is `"2.0"`.
- `id` is any JSON value. **Presence of `id` is what makes a frame a request**;
  a frame with no `id` is a notification and is never answered.
- `method` must be a non-empty string.
- `params` is an object. An absent `params` is treated as empty by the shell;
  in the kernel, absent means no parameters (handlers use defaults).

### Response

```json
{"jsonrpc":"2.0","id":1,"result":{"path":"examples/hello.bf","text":"...","revision":123456789,"eol":"lf","size":1234,"mtime":1700000000}}
```

Exactly one of `result` or `error` is present. When a handler produced no
result, `result` is an empty object (`{}`), never `null`.

### Error

```json
{"jsonrpc":"2.0","id":1,"error":{"code":1002,"name":"NOT_FOUND","message":"no such file"}}
```

`error` carries `code` (integer), `name` (the symbolic name), `message` (human
text) and, for a few failures, `data`. `name` is the machine-readable half;
clients should branch on `name`, not on `message`.

### Notifications

```json
{"event":"proc.output","run_id":1,"stream":"stdout","data":"Hello World!\n"}
```

Notifications carry `event` and have **no `id`**. They may appear between
responses at any time. The event list is below.

---

## The kernel method table

The authoritative table is `sde_methods[]` in `core/src/rpc.c`. With both
compile-time switches on (`SDE_WITH_VIEW`, `SDE_WITH_PROC`) there are eighteen
methods. `view.*` disappears when `SDE_WITH_VIEW` is 0; `proc.*` disappears
when `SDE_WITH_PROC` is 0.

| method | parameters | result |
| --- | --- | --- |
| `hello` | none | `{protocol, protocol_name, kernel_version, root, pid}` |
| `workspace.info` | none | `{root, name, file_count, view_path, view_revision, ignored}` |
| `workspace.list` | `path?`, `glob?`, `limit?` | `{files, truncated, count}` |
| `file.read` | `path` | `{path, text, revision, eol, size, mtime}` (+ `lang` from the shell) |
| `file.write` | `path`, `text`, `base_revision?` | `{path, revision, eol, size}` |
| `file.stat` | `path` | `{path, exists, dir, size, mtime, revision}` |
| `file.blobOpen` | `path`, `mode`, `base_revision?`, `want_revision?` | `{session, path, size, revision?}` |
| `file.blobRead` | `session`, `offset?`, `length?` | `{session, offset, size, eof, data}` |
| `file.blobAppend` | `session`, `data`, `offset?` | `{session, offset, size}` |
| `file.blobCommit` | `session`, `total_size` | `{path, size, revision, replaced}` |
| `file.blobAbort` | `session` | `{aborted}` |
| `view.load` | `path` | `{path, revision, document}` |
| `view.save` | `path`, `document`, `base_revision?` | `{path, revision, saved}` |
| `proc.start` | `cmd`, `cwd?` | `{run_id}` |
| `proc.send` | `run_id`, `data` | `{written}` |
| `proc.close` | `run_id` | `{closed}` |
| `proc.stop` | `run_id` | `{stopped}` |
| `proc.list` | none | `{runs}` |

`?` marks an optional member. Members marked without `?` are required; omitting
or mis-typing them produces `-32602 INVALID_PARAMS`.

### `hello`

```json
{"protocol":3,"protocol_name":"seide/3","kernel_version":"0.3.0-alpha.1","root":"C:/work/seIDE","pid":12345}
```

`protocol` is the integer a client can compare; `protocol_name` is the same
version spelled out for a human reading a log line.

`seide/3` is the version that made a child process a *channel* instead of a
runner: `exec.*` became `proc.*`, `card_id` disappeared from the protocol
altogether, and a client can now write to a child's standard input and close it
(`proc.send`, `proc.close`). A language server needs exactly that and nothing
else, which is why the rename happened in one step rather than two. See
`docs/SUBSYSTEMS.md`.

`seide/2` is the version that made the view document opaque: the kernel stores a
client's document, hands it back, and has no opinion about what is inside it.
See `docs/VIEWS.md` for why that line is where it is.

### `workspace.info`

```json
{"root":"C:/work/seIDE","name":"seIDE","file_count":42,"view_path":".seide/board.json","view_revision":3901234567,"ignored":[".git",".seide",".hg",".svn","node_modules","__pycache__",".vscode",".idea",".cache","dist","build","target","obj"]}
```

`name` is the last path segment of `root`. `view_path` is the path of the
document the kernel last read or wrote, relative to the root (an empty string
before any call has handed it one). `view_revision` is a number: the revision of
that document, or 0 when the kernel holds nothing. Both are a report of what the
kernel did last, not a workspace setting -- the client names the path on every
call, and a kernel that has read no document has no path to report. `ignored`
names the directories `workspace.list`
skips (see that section): absent rows look exactly like an empty directory, so a
client that wants to explain a missing `build/` has to be told, and telling it
here means the list is never written down twice.

**The shell adds one more member to this result:**

```json
{"langs":[{"id":"brainfuck","title":"Brainfuck","extensions":[".bf"]},{"id":"html","title":"HTML","extensions":[".html",".htm",".xhtml"]},{"id":"xml","title":"XML","extensions":[".xml",".svg",".xsl",".xslt",".xsd",".rss",".atom",".plist",".xaml",".csproj",".resx",".props",".targets"]}]}
```

The kernel is language-agnostic, so the language inventory is added by the layer
that owns it (`shell/main.mjs`). A client talking to the kernel endpoint
directly will not see `langs`; a client talking to the shell will. `tools/e2e.py`
requires it in full mode and reports the language checks as *skipped* in kernel
mode.

### `workspace.list`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, optional | a subdirectory; joined as `path/glob` |
| `glob` | string, optional | default `**/*` |
| `limit` | number, optional | default/≤0 means the internal cap of 20000 |

Result:

```json
{
  "files": [
    {"path":"core/src/buf.c","dir":false,"size":4211},
    {"path":"core/src","dir":true,"size":0}
  ],
  "truncated": false,
  "count": 2
}
```

`path` is relative to the workspace root and uses `/`. Directories report
`size: 0`. A `.mtime` member is documented on the header and returned by
`file.read`; `workspace.list` items carry `path`, `dir` and `size` only.

The walk skips `.git`, `.seide`, `.hg`, `.svn`, `node_modules`, `__pycache__`,
`.vscode`, `.idea`, `.cache`, `dist`, `build`, `target` and `obj`, caps
directory depth at 24, and **skips an unreadable directory rather than
failing**. Glob rules: `*` matches within one segment, `?` matches one
non-separator character, `**` matches across separators (and matches zero
directories, so `**/*.bf` finds a file at the top level). Comparison is
case-folded because Windows paths are case-insensitive: a glob that behaved
differently from the filesystem underneath it would be a bug generator.

### `file.read`

Required parameter: `path` (non-empty string, relative to the workspace root).

```json
{"path":"examples/hello.bf","text":"...","revision":123456789,"eol":"lf","size":1234,"mtime":1700000000}
```

`revision` is a 32-bit FNV-1a hash of the file's bytes, carried as a number;
it is the token `file.write` checks. `eol` is `"crlf"` or `"lf"` (`"lf"` when
the text contains no newline). A file that does not exist reports revision 0.

A document's revision is a hash of the same kind, but taken over a **canonical**
rendering of the document: object members are sorted by name before hashing
(`sde_json_write_canonical()` in `core/src/json.c`). Two documents with the same
content therefore have the same revision no matter how the client spelled them,
which is what makes `base_revision` safe to compare across clients. The canonical
form exists only for hashing; the `document` the kernel hands back is the
client's own arrangement, exactly as it was stored.

**The shell adds one more member to this result:**

```json
{"path":"examples/hello.bf","text":"...","revision":1873099737,"eol":"lf","size":820,"mtime":1700000000,"lang":"brainfuck"}
```

`lang` is the language the shell detected from the path, or `null` when nothing
matched. It is not in the kernel's result and the kernel has no opinion about
it; `tools/e2e.py` requires it in full mode and tolerates its absence in kernel
mode.

Refusals, all `IO` (1003) except the first:

| condition | code | name | message |
| --- | --- | --- | --- |
| no such file | 1002 | `NOT_FOUND` | `no such file` |
| directory | 1003 | `IO` | `is a directory` |
| larger than 4 MiB | 1003 | `IO` | `file is too large to open` |
| contains a NUL byte | 1003 | `IO` | `file is binary` |

Absolute paths and `..` escapes are refused before any of that: `sde_wksp_resolve`
rejects `absolute paths are not allowed: <path>` and
`path escapes the workspace: <path>`, surfaced as `IO`.

### `file.stat`

Required parameter: `path` (non-empty string, relative to the workspace root).

```json
{"path":"examples/hello.bf","exists":true,"dir":false,"size":820,"mtime":1792066269,"revision":1873099737}
```

`revision` is the same number `file.read` would report for those bytes. That is
the whole reason the method exists: a client holding a revision can ask whether
the file on disk is still the one it read, on a timer, without carrying the text
back and forth every time.

It is not a `stat(2)`. To answer with that revision the kernel opens the file,
reads it (up to the same 4 MiB cap `file.read` has) and hashes it. What it saves
is the trip, not the syscall: no text on the wire, no decoding, one small object
per file per poll.

A file that is not there is a **result, not an error** — `exists: false`,
`size: 0`, `mtime: -1`, `revision: 0`. "Gone" is one of the answers a watcher
needs, and an error would have to be told apart from a kernel that is merely
unhappy.

`revision: 0` always means **no revision to compare**, which is not the same as
"empty":

| the path names | `exists` | `dir` | `size` | `mtime` | `revision` |
| --- | --- | --- | --- | --- | --- |
| a text file | `true` | `false` | bytes | seconds | its hash |
| an empty file | `true` | `false` | `0` | seconds | the hash of no bytes, not `0` |
| a directory | `true` | `true` | `0` | seconds | `0` |
| nothing | `false` | `false` | `0` | `-1` | `0` |
| a file over 4 MiB, or one holding a NUL byte | `true` | `false` | bytes | seconds | `0` |

A client that finds `revision: 0` where it expected a number must read it as
"cannot tell", never as "unchanged" or "empty". The shell's watcher warns about
such a card instead of reloading over it.

`file.write` reads the same value, and refuses when it cannot. If the file on
disk exists but the kernel cannot read it to compute a revision (a permission or
I/O failure), a write fails with `1003 IO` and the kernel's own message
(`cannot read the file on disk: <path>`) instead of treating the base as a
match. Overwriting a file whose bytes the kernel cannot compare is exactly the
lost update `base_revision` exists to prevent, so "cannot say" must not mean "go
ahead". A file that *is* readable, including one holding a NUL byte, has a real
revision: `file.write` compares it, and a client that hands back the `0` it saw
from `file.stat` gets `1001 STALE_REVISION`, not a silent overwrite.

Everything else is refused exactly as `file.read` refuses it: a missing `path`
is `-32602 INVALID_PARAMS`, and an absolute path or a `..` escape is
`1003 IO`. A missing **file**, again, is not a refusal.

### `file.write`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, required | relative path; parent directories are created |
| `text` | string, required | the whole new contents; send `""` to empty the file. A non-string is `INVALID_PARAMS` with `` `text` must be a string ``, and omitting it is `INVALID_PARAMS` too |
| `base_revision` | number, optional | the revision the client read; omit for last-writer-wins |

Result: `{"path":"examples/hello.bf","revision":987654321,"eol":"lf","size":1240}`.

The bytes are published atomically: the kernel writes a neighbouring temporary
file and replaces the target with it, so a reader — or a crash — sees the whole
old file or the whole new one, never half of one. `view.save` has always done
this; `file.write` now uses the same port call (`sde_port_write_file`) rather
than writing in place.

With a `base_revision` that no longer matches the file on disk, the write is
refused with:

```json
{"jsonrpc":"2.0","id":3,"error":{"code":1001,"name":"STALE_REVISION","message":"file changed on disk since it was read","data":{"current_revision":987654321}}}
```

On success the kernel emits a notification **before** the response is written:

```json
{"event":"file.changed","path":"examples/hello.bf","revision":987654321}
```

### Binary and large files: blob sessions

`file.read` and `file.write` carry a file inside a JSON string, which puts two
things out of reach at once: a JSON string cannot carry a NUL byte, and
`file.read` refuses any file over 4 MiB. The five `file.blob*` methods move the
bytes through a *session* instead. Same workspace, same path containment, same
revisions as `file.read` and `file.write`; only the shape of the transfer is
different.

A session is opened once, used for as many chunks as the file needs, and then
either published (`file.blobCommit`) or thrown away (`file.blobAbort`). Bytes
travel in `data` as standard base64 with padding, so a chunk costs 4 characters
on the wire for every 3 bytes, and one call carries at most 1 048 576 decoded
bytes. The kernel holds at most eight sessions at once and forgets one that has
been idle for fifteen minutes; a session that is forgotten takes its temporary
file with it.

#### `file.blobOpen`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, required | relative path, resolved exactly as `file.read` resolves it (so `..` and an absolute path are refused) |
| `mode` | string, required | `"read"` or `"write"`; anything else is `INVALID_PARAMS` |
| `base_revision` | number, optional | write mode only: the revision the client read. A mismatch is `1001 STALE_REVISION` with `data.current_revision`, and **no** session and no temporary file are created |
| `want_revision` | boolean, optional | read mode: also hash the file and return its current `revision` |

Result: `{"session":1,"path":"assets/logo.png","size":91234}`, plus
`"revision":<n>` when `base_revision` or `want_revision` asked for it.

A read session needs the file to exist (`1002 NOT_FOUND` if it does not); a
write session does not — it writes a neighbouring `<path>.tmp` and creates
missing parent directories exactly as `file.write` does. Only one write session
may target a path at a time. The revision is computed *before* the slot is
taken, so a stale `base_revision` leaves nothing behind.

#### `file.blobRead`

| parameter | type | meaning |
| --- | --- | --- |
| `session` | number, required | a session opened with `mode:"read"` |
| `offset` | number, optional | where to start; default: where the session stopped |
| `length` | number, optional | how many bytes, 1 to 1 048 576; default: 1 048 576 |

Result: `{"session":1,"offset":0,"size":91234,"eof":false,"data":"<base64>"}`.

`offset` in the result is where the returned bytes begin — which is where the
session's position was, or the `offset` that was asked for. Asking past the end
of the file is **not** an error: the answer is clamped to the end, `data` is
empty and `eof` is `true`. The session's position always becomes
`offset + bytes returned`, so an explicit `offset` moves the sequential cursor
too — a client that wants random access should send `offset` on every read. The
file is re-measured on each read, so a file that grows or shrinks under the
client is followed rather than misread.

#### `file.blobAppend`

| parameter | type | meaning |
| --- | --- | --- |
| `session` | number, required | a session opened with `mode:"write"` |
| `data` | string, required | base64; decoded it must be at most 1 048 576 bytes |
| `offset` | number, optional | if present it must equal the bytes written so far |

Result: `{"session":1,"offset":1048576,"size":1048576}`; `offset` and `size` are
the same number and both are the new total. The first append creates (and
truncates) `<path>.tmp`; later ones append to it. A chunk that is not valid
base64 is `INVALID_PARAMS` with `` `data` is not valid base64 ``. The append is
deliberately *not* atomic: the temporary file is a staging area, and the target
is only ever replaced by `file.blobCommit`.

#### `file.blobCommit`

| parameter | type | meaning |
| --- | --- | --- |
| `session` | number, required | a write session |
| `total_size` | number, required | the whole file's size; a mismatch is `INVALID_PARAMS` |

Result: `{"path":"assets/logo.png","size":91234,"revision":3901234567,"replaced":true}`.

`total_size` is what makes "the last chunk" a statement rather than a guess: the
kernel publishes only when it equals the bytes actually written. Publication is
atomic — the temporary file replaces the target — and the revision reported is
the same number `file.read` and `file.stat` give for those bytes (FNV-1a over
them). `file.changed` is emitted before the response, exactly as `file.write`
emits it. A refused commit does **not** throw the session away: the client may
send more chunks and commit again.

#### `file.blobAbort`

| parameter | type | meaning |
| --- | --- | --- |
| `session` | number, required | any open session |

Result: `{"aborted":true}`. The session is closed and its temporary file
removed. Aborting a session a second time — or naming a session that never
existed — is `INVALID_PARAMS` with `no such blob session`.

Not every client will be so tidy: the next `file.blobOpen` on the same path
removes a `<path>.tmp` left behind by a kernel that died mid-session, and a
kernel that shuts down removes the temporary files of every session still open.

### `view.load`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, required | the document, relative to the workspace root |

```json
{"path":".seide/board.json","revision":3901234567,"document":{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"cards":[],"links":[]}}
```

A path that does not exist is not an error: the result is `"document":null` and
`"revision":0`, which is what a first run looks like. `document` is a clone, so a
client may keep and mutate it freely.

Loading also makes that document the one the kernel holds -- it is what the
next `view.save`'s `base_revision` is compared against, and what
`workspace.info` reports. The kernel holds one document at a time: the last one
a call read or wrote.

### `view.save`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, required | where the document goes, relative to the workspace root |
| `document` | any JSON value except `null`, required | the document |
| `base_revision` | number, optional | the revision the client last read |

Result: `{"path":".seide/board.json","revision":3901234568,"saved":true}`, plus a
notification:

```json
{"event":"view.changed","path":".seide/board.json","revision":3901234568}
```

The document is **opaque**: the kernel checks that it is JSON and that it is not
`null`, and nothing else. An object, an array, a string, a number and a boolean
all round-trip byte-for-byte, and the board schema below is not the kernel's
business -- see `docs/VIEWS.md`.

Failure modes, in the order the kernel checks them:

| condition | code | name | message / data |
| --- | --- | --- | --- |
| `document` absent or `null` | -32602 | `INVALID_PARAMS` | `` `document` must be a JSON value, and not null `` |
| `base_revision` present, not a number | -32602 | `INVALID_PARAMS` | `` `base_revision` must be a number when it is present `` |
| `base_revision` present and ≠ current | 1001 | `STALE_REVISION` | `the view document changed since it was loaded`, data `{current_revision}` |
| the file could not be written | 1003 | `IO` | the store's message, e.g. `cannot write the view document` |

"Current" means the revision of the document the kernel holds -- the last one a
call read or wrote, so a client that has just loaded the file can pass that
revision back. A different path, or no call at all, is not the same revision:
`base_revision` guards *this* document, and a client that wants to overwrite
something it never read should leave the member out and say why. The staleness
check happens **before** anything is written, so a rejected save leaves both the
file and the held document untouched. The write itself is atomic: a neighbour
file is replaced into place, so a reader or a crash sees the whole old document
or the whole new one.

### `proc.start`

| parameter | type | meaning |
| --- | --- | --- |
| `cmd` | string, required | a command line; the platform parses it, so an executable plus arguments |
| `cwd` | string, optional | resolved through the workspace; empty/absent means the workspace root |

Result: `{"run_id":1}`.

There is no `card_id`: the kernel does not know which card, view or subsystem
asked. That is the client's business, and a run id is enough to match events to
the thing that started it.

A `cwd` that escapes the workspace is refused with `-32602 INVALID_PARAMS`.
A process that cannot start is `1005 PROC`. Runs are capped at 64 live entries;
when the table is full the kernel drops the oldest **finished** run, and if
every run is still alive it lets the table grow instead.

### `proc.send`

| parameter | type | meaning |
| --- | --- | --- |
| `run_id` | number, required | which run |
| `data` | string, required | UTF-8 bytes for the child's standard input |

Result: `{"written":<bytes>}`. The write is queued and a writer thread drains it,
so a child that reads slowly cannot block the kernel: `written` is what was
accepted, and a queue that is full is refused with `1005 PROC`
(`the process is not reading its input`) rather than waited on. After
`proc.close` a further `proc.send` is the same `1005`.

### `proc.close`

Parameter: `run_id`. Result: `{"closed":true}`. The child's standard input is
closed, which is how a program that reads until EOF learns there is no more; the
run itself stays alive until it exits or is stopped. An unknown id is
`1002 NOT_FOUND`.

### `proc.stop`

Parameter: `run_id` (number; a non-number is `-32602` with
`` `run_id` must be a number ``). Result: `{"stopped":true}`. An unknown id is
`1002 NOT_FOUND` with `no such run`.

### `proc.list`

```json
{"runs":[{"run_id":1,"cmd":"python tools/bf.py examples/hello.bf","running":false,"code":0,"started":1700000000000}]}
```

`code` is `-1` while the run is alive or was killed. `started` is
`sde_port_now_ms()` (milliseconds since the platform epoch). There is **no
`pid` member**, despite the header comment mentioning one, and no `card_id`.

---

## Notifications

| event | members | emitted when |
| --- | --- | --- |
| `file.changed` | `path`, `revision` | a successful `file.write` or `file.blobCommit` |
| `view.changed` | `path`, `revision` | a successful `view.save` |
| `proc.output` | `run_id`, `stream`, `data` | the pump read bytes from a child |
| `proc.exit` | `run_id`, `code` | a child exited and every byte was consumed |
| `log` | `message` | the transport dropped an oversized frame |

`proc.output.stream` is `"stdout"` or `"stderr"`. Each output notification
carries at most 8192 bytes (`SDE_PROC_READ_MAX`), one read per run per 15 ms
pass, which keeps a chatty process from starving the others.

The shell's board UI reacts to `view.changed` by ignoring its own revision echo;
if the board is dirty it warns, otherwise it re-runs `view.load` to adopt what
is on disk. A second client writing the same document is exactly the case this
covers: the event names the path, so a client that holds several documents can
tell which one moved.

`file.changed` is only ever emitted for a write **this kernel made**. A file
changed by another program — an editor, a formatter, `git checkout` — produces no
notification at all, because the kernel is not watching the filesystem. A client
that wants to know has to ask: poll `file.stat` for the paths it holds, which is
what the shell's watcher does (`shell/web/watch.mjs`), or watch the directory
itself and say so. The protocol deliberately does not promise the second one.

---

## A second client

A contract with one consumer is a contract nobody has tested, so the repository
ships a second one: `tools/seide_cli.py`, a command-line client that speaks this
document and imports nothing from `shell/`.

```sh
python tools/seide_cli.py hello                     # protocol, kernel version, root, pid
python tools/seide_cli.py info                      # workspace.info
python tools/seide_cli.py ls "**/*.py" --limit 20   # workspace.list
python tools/seide_cli.py cat README.md --meta      # file.read; metadata on stderr
python tools/seide_cli.py write notes.txt --text "hello\n"   # file.write
python tools/seide_cli.py board                     # view.load, as a table
python tools/seide_cli.py board --path notes.json   # the same, for any document
python tools/seide_cli.py run "python tools/bf.py examples/hello.bf"
python tools/seide_cli.py selfcheck                 # the client's own checks
```

Three things about it are the point:

- It talks to the **kernel** endpoint. `lang.list` is a shell method, so the
  client's self-check asserts the kernel still answers `-32601
  METHOD_NOT_FOUND` for it -- the boundary in the first section of this document,
  machine-checked.
- It keeps the rails the protocol defines rather than inventing its own: `write`
  refuses to replace an existing file unless it is given the `base_revision` it
  last read (`--base-revision`) or told `--force`, and a stale revision comes
  back as `1001 STALE_REVISION` with the file untouched.
- Its checks run inside `make test` as `cli-check` (`make cli-check` on its own),
  against a scratch workspace under `build/`, so the second consumer cannot rot
  unnoticed.

---

## Standard JSON-RPC codes

| code | name | when |
| --- | --- | --- |
| -32700 | `PARSE_ERROR` | the frame was not valid JSON, or carried a string this transport cannot represent (a U+0000 code point); built by the reader loop, sent with a **null** id |
| -32600 | `INVALID_REQUEST` | the frame was not an object, or had no string `method` on a request |
| -32601 | `METHOD_NOT_FOUND` | no such method; message is `` no such method `NAME` `` |
| -32602 | `INVALID_PARAMS` | a required parameter was absent, empty or the wrong type |
| -32603 | `INTERNAL` | out of memory, or an unexpected internal failure |

## Application codes (frozen, from `core/include/rpc.h`)

| code | name | when |
| --- | --- | --- |
| 1001 | `STALE_REVISION` | `file.write`, `file.blobOpen` or `view.save` with an out-of-date `base_revision`; carries `data.current_revision` |
| 1002 | `NOT_FOUND` | `file.read` or `file.blobOpen` on an absent file; `proc.stop` or `proc.close` on an unknown run |
| 1003 | `IO` | read/write/list/save failures not covered above |
| 1004 | *(retired)* | was `INVALID_BOARD`; the kernel no longer validates a document, so nothing emits it. The number stays reserved: a client that reads `1004` from an older kernel is looking at a fork or at `seide/1` |
| 1005 | `PROC` | a child process could not be started, could not be written to, or its input is closed |

`INVALID_PARAMS` messages are uniform: the helper that reads a required string
emits ``missing non-empty string `KEY` `` naming the parameter.

## Shell-local error names (HTTP client, not the kernel)

The browser client `shell/web/rpc.mjs` additionally produces transport-level
errors that never come off the wire: `TRANSPORT`, `CLIENT_CLOSED`,
`HTTP_STATUS`, `BAD_REPLY`. The shell process itself (`shell/main.mjs`) uses
`KERNEL_GONE`, `TIMEOUT` and `WRITE_FAILED` when it cannot reach or write to the
kernel. These are not part of the frozen kernel protocol; a fork may replace
them along with the transport.

---

## HTTP endpoint (what the browser uses)

`node shell/main.mjs serve` serves `shell/web/` as static files and offers two
dynamic routes:

| route | shape |
| --- | --- |
| `POST /rpc` | body is one JSON frame; the reply is one JSON frame with `Content-Type: application/json` |
| `GET /events` | `text/event-stream`; one `data: <json>\n\n` per notification |

The browser client posts the **same frame shape** as stdio —
`{"jsonrpc":"2.0","id":N,"method":"...","params":{...}}` — because the shell's
`dispatch()` is shared by both modes. A frame with no `id` is a notification and
is answered with `204 No Content`, since HTTP always needs a status but there is
no response frame to give. The SSE subscriber set also receives a `: keep-alive`
comment every 15 seconds.

The `id` on an HTTP request is what makes it a request. A frame with no `id` is
a notification: the host answers `204`, there is no reply frame, and the browser
client has nothing to resolve its promise with. `shell/web/rpc.mjs` guards that
two ways — it always mints an `id`, and every call is bounded by its own
timeout, so a missing reply settles as a `TIMEOUT` rejection rather than a
promise that never settles.

Requests to `/rpc` with a body that is not JSON get `400` and a
`PARSE_ERROR` frame with a null id. Non-GET/HEAD/POST methods get `405`.

---

## The `.lang` descriptor grammar

The grammar is frozen and documented in `langs/README.md`. A descriptor is a
plain text file, one `key value` per line:

```
# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
```

Rules:

- A line whose **first byte** is `#` is a comment. An indented `#` is not.
- Blank lines are ignored.
- Keys: `id`, `title`, `ext`, `family`, `raw_element`, `line_comment`,
  `block_comment_open`, `block_comment_close`, `string`, `kind`.
- `ext`, `string` and `raw_element` may repeat; the others may not be
  meaningfully repeated.
- **An unknown key is a hard error.**
- Markers take a raw form (`#`, `//`, `/*`) or a quoted form (`"#"`).
- `kind <kindname> "<token>" ...`, where `<kindname>` is one of `keyword`,
  `command`, `type`, `constant`, `number`, `string`, `comment`. Tokens are
  always double-quoted, with `\"`, `\\`, `\n`, `\t` and `\r` understood. An
  unquoted token is a hard error.
- **The token text, not the kind, decides how it matches**: a token starting
  with a letter or `_` matches as a whole word; anything else matches literally,
  longest first.
- `family flat` (the default) is the scanner above. `family sgml` selects the
  HTML/XML scanner, and `raw_element "script" "style"` lists elements whose body
  is text rather than markup. The two families do not mix: a flat-scan key
  (`line_comment`, `block_comment_*`, `string`, `kind`) in a `family sgml`
  descriptor is a hard error, `raw_element` without `family sgml` is a hard
  error, and an unknown family is a hard error. Neither key ever appears in a
  `lang.*` result — they are facts about scanning, not about the wire.

`parseDescriptor` throws `LangError` (with `source` and a 1-based `line`) on any
grammar violation; `loadLanguages(dir, { onError })` reports and skips bad files
so one broken descriptor cannot take the language layer down.

Scaffold a new one:

```sh
python tools/newlang.py --id mylang --ext .ml --keywords "if,else,while"
python tools/newlang.py --id myhtml --ext .mh --family sgml --raw-element script
```

### Verbatim: `langs/brainfuck.lang`

```
# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
```

### Verbatim: `langs/html.lang`

```
# seIDE language descriptor
id html
title HTML
ext .html
ext .htm
ext .xhtml
family sgml
raw_element "script" "style" "textarea" "title"
```

`langs/xml.lang` is the same shape without `raw_element`, covering `.xml` and the
extensions built on it (`.svg`, `.xsl`, `.xsd`, `.rss`, `.atom`, `.plist`, …).

---

## The shell-owned language methods

These are answered **by the shell**, not by the kernel. A client talking to the
kernel endpoint directly will get `METHOD_NOT_FOUND` for both.

### `lang.list`

Parameters: none.

```json
{"langs":[{"id":"brainfuck","title":"Brainfuck","extensions":[".bf"]},{"id":"html","title":"HTML","extensions":[".html",".htm",".xhtml"]},{"id":"xml","title":"XML","extensions":[".xml",".svg",".xsl",".xslt",".xsd",".rss",".atom",".plist",".xaml",".csproj",".resx",".props",".targets"]}]}
```

`extensions` is lowercase and includes the dot; a client matches by
case-insensitive suffix. Only `id`, `title` and `extensions` are on the wire —
a descriptor's `family` and `raw_element` are scanning facts and stay in the
language layer.

When `langs/` has been deleted, the shell's fallback answers `{"langs":[]}`.

### `lang.tokenize`

| parameter | type | meaning |
| --- | --- | --- |
| `text` | string, required | the text to tokenize; a non-string is `-32602 INVALID_PARAMS` with ``lang.tokenize needs a string `text` `` |
| `path` | string, optional | used to detect the language by extension |
| `lang` | string, optional | an explicit language id; it wins over `path` |

```json
{"tokens":[[0,2,"command"],[2,3,"punct"],[3,4,"command"]],"lang":"brainfuck"}
```

`tokens` is an array of `[start, end, kind]` triples over **string indices**:
UTF-16 code units, the unit `text.length` counts in. They are *not* byte offsets
— a client that counts bytes must convert, and so must one that counts code
points (an astral character is two code units). `lang` is the resolved language
id, or `null` when nothing matched.

Guarantees:

- Spans **tile the whole input**: every offset from 0 to `text.length` is
  covered exactly once, in order. Whitespace is reported as `ws` rather than
  skipped.
- Kinds on the wire: `keyword`, `command`, `type`, `constant`, `number`,
  `string`, `comment`, `ident`, `punct`, `ws`. (`ident`, `punct` and `ws` are
  produced, never declared.) The kind set is the same for every family, so a
  client that understands Brainfuck understands HTML's tokens too.
- Frozen scan order, per family:
  - `flat`: **block comment → line comment → string → number → identifier →
    literal → punctuation**.
  - `sgml`: **comment → doctype/processing instruction → tag or entity → text**.
- An unterminated string or block comment stops at end of line / end of input,
  so one stray quote never darkens the rest of the file. SGML keeps the same
  promise in its own terms: an unterminated comment, tag, attribute string or
  CDATA section ends at end of input.
- With no descriptor matching, `lang.tokenize` still returns a valid tiling:
  blank runs are `ws`, everything else is `punct`.
- With `langs/` deleted, the fallback returns one span covering the input with
  the kind `plain` and `lang: null`.

The editor card in the shell calls `lang.tokenize` with `{path, text}` on a
120 ms debounce and discards stale replies.

---

## The view document

The kernel's whole contract for a document is: it is JSON, it is not `null`, it
is stored verbatim, and it comes back with a revision. What is *inside* it is the
client's business; `docs/VIEWS.md` argues why. What a client can rely on:

- Any JSON value except `null` round-trips: an object, an array, a string, a
  number, a boolean. `null` is refused because "no document" and "a document
  whose value is null" have to stay distinguishable.
- Nothing is repaired, reordered or dropped. What is stored is the canonical
  form of what was sent, and `revision` is the hash of that canonical form, so
  re-saving unchanged content does not move the revision.
- The write is atomic -- a neighbour file is replaced into place -- so a crash or
  a concurrent reader sees one whole document, not half of one.
- The kernel does not read the file at start-up. A hand-edited or corrupt
  document cannot stop the kernel from running; a client decides what to do with
  a file it cannot parse.
- A missing file is not an error anywhere: `view.load` says `document: null`,
  `revision: 0`.

**The board schema is a client convention.** `shell/web/board.mjs` owns it, and
`docs/PARADIGM.md` describes what the shape is for. The rules it enforces when
it serialises a document (`serialize:` messages, `shell/web/board.mjs`):

- a card is an object with a non-empty string `id`, a non-empty string `kind`
  and numeric geometry; card ids are unique in the document;
- a link is an object naming two existing cards, with a unique link id;
- a document is a JSON object, and whatever a card carries beyond what the
  client itself uses is kept **verbatim** -- the client does not interpret it
  either, it only insists the document is something it can draw.

On load the client is more forgiving than on save: absent members are filled
with defaults so a hand-written `board.json` only has to be right about the
meaningful parts, while a *mis-typed* member is not repaired -- repairing a
missing member helps a human editing a file by hand, repairing a wrong-typed one
would let a bug silently replace the whole board (`docs/BUGS.md`, entry A).

The kernel used to enforce those rules itself (`1004 INVALID_BOARD`,
`core/src/board.c`). That module is gone with the `seide/2` protocol version, and
with it the class of bug where a client's document is a reason for the kernel to
refuse to work (`docs/BUGS.md`, entries N8 and N10).
