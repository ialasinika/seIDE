#!/usr/bin/env python3
"""e2e.py -- end-to-end driver for the seIDE kernel protocol.

    python tools/e2e.py [--seide PATH | --seide-cmd CMD] [--fixture PATH]
                        [--timeout SEC] [--keep-going] [--json]

Spawns an endpoint and speaks newline-delimited JSON-RPC over its
stdin/stdout:

* **requests** are ``{"id": N, "method": ..., "params": {...}}`` plus ``\\n``;
* **responses** carry the same ``id`` plus ``result`` or ``error``;
* **notifications** carry an ``event`` field and **no** ``id``.

Two reader threads demultiplex those lines, so a chatty kernel can never deadlock
the driver, and every request has a timeout.  The child is always killed on exit,
including when a check fails.

The scenario asserted here is the frozen protocol exercised in order: hello,
workspace.info, lang.list, lang.tokenize (plus its tiling property),
file.read / file.write / stale write, path containment, the view document
round-trip, the shipped starter board, a real ``proc.start`` run whose stdout
must contain the Brainfuck program's output, and the duplex channel a subsystem
needs (``proc.send`` into a child's stdin, ``proc.close`` to end it).  The two write checks have to edit the fixture to move its revision
(a revision is a content hash) and write the original bytes back afterwards, so
a completed run leaves the file byte-identical.

The view document is stored at a path **this tool chooses**
(``DOCUMENT_PATH``, the same one the shell uses): since seide/2 the kernel keeps
a document without reading it, so the path, the schema and the bytes are all
client business -- except that what goes in must come back out unchanged.

Endpoint modes
    Languages are no longer part of the C kernel: the shell multiplexer serves
    ``lang.list`` / ``lang.tokenize`` and forwards the kernel methods.

    * **kernel mode** (default, ``--seide build/seide.exe``): the driver spawns
      ``<seide> rpc``.  The kernel does not serve ``lang.*``, so those checks
      (four, counting the tiling assertion and the SGML file) are reported as
      *skipped (kernel mode)* and ``workspace.info`` is not required to carry
      ``langs``.
    * **full mode** (``--seide-cmd "node shell/main.mjs rpc --workspace ."``):
      the command line is spawned verbatim -- nothing (not even ``rpc``) is
      appended.  ``workspace.info.langs`` is required and the tokenizer checks
      run, including the assertion that token spans tile the whole input.

Fixture
    ``--fixture`` names the Brainfuck program used by the checks.  Without it the
    driver prefers ``examples/hello.bf`` and otherwise creates the scratch
    ``examples/shadow.bf``; if it cannot use a file at all it falls back to an
    inlined program that prints ``hi``.

Exit codes
    0   every check passed
    1   at least one check failed (or checks were skipped after a failure)
    2   the driver could not start (missing seide binary, unusable fixture, ...)
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import collections
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BF_PY = Path(__file__).resolve().parent / "bf.py"

#: Default kernel binary, relative to the repository root (kernel-only mode).
KERNEL_DEFAULT = "build/seide.exe"

#: Fallback Brainfuck program: prints exactly ``hi`` and uses a loop.
INLINE_BF = "++++++++++[>++++++++++<-]>++++.+."
INLINE_LF = INLINE_BF + "\n"

#: Appended to a file to make a real content change for the revision checks.
#: Every byte outside ``+-<>[].,`` is a comment to Brainfuck, so the file still
#: runs to exactly the same output while it is edited.
REVISION_PROBE = "\n# e2e: revision probe\n"

#: The command handed to ``proc.start``; ``{python}``/``{bf}``/``{fixture}`` are filled in.
PROC_TEMPLATE = '"{python}" "{bf}" "{fixture}"'

#: Where this suite keeps its document.  The kernel has no opinion: a view
#: document's path is the *client's* convention, and this is the same one
#: `shell/web/board.mjs` uses, so the suite exercises the path a real user has.
DOCUMENT_PATH = ".seide/board.json"


class DriverError(Exception):
    """The driver itself could not proceed (bad binary, timeout, dead child)."""


class RpcError(Exception):
    """The kernel answered a request with an ``error`` object."""

    def __init__(self, code: str, message: str, raw=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.raw = raw if isinstance(raw, dict) else {}


class CheckFailed(Exception):
    """An assertion about the protocol did not hold."""


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"e2e.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


class Style:
    """Tiny ANSI helper; colour is switched off for pipes and ``NO_COLOR``."""

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _paint(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def ok(self, text: str) -> str:
        return self._paint(text, "32")

    def bad(self, text: str) -> str:
        return self._paint(text, "31")

    def dim(self, text: str) -> str:
        return self._paint(text, "2")

    def bold(self, text: str) -> str:
        return self._paint(text, "1")


def colour_enabled(stream) -> bool:
    """True only when *stream* is a TTY and NO_COLOR/TERM=dumb do not forbid it."""
    if "NO_COLOR" in os.environ or os.environ.get("TERM") == "dumb":
        return False
    return bool(getattr(stream, "isatty", lambda: False)())


def split_command(text: str) -> list:
    """Split a command string on whitespace, honouring double quotes.

    Hand-written so Windows paths keep their backslashes (``shlex`` would eat
    them in POSIX mode and keep the quotes in non-POSIX mode).
    """
    return [match.group(1) if match.group(1) is not None else match.group(2)
            for match in re.finditer(r'"([^"]*)"|(\S+)', text)]


def resolve_argv(setting: str, explicit: bool) -> list:
    """Turn ``--seide`` into an argv list.

    A path to an existing file is used as-is; anything else is split like a shell
    command, which keeps the documented ``--seide build/seide.exe`` contract while
    letting a test drive ``--seide "python tools/stub.py"``.
    """
    candidate = Path(setting)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    if candidate.is_file():
        return [str(candidate)]
    argv = split_command(setting)
    if not argv:
        raise DriverError("--seide is empty")
    if Path(argv[0]).is_file() or shutil.which(argv[0]):
        return argv
    if not explicit:
        raise DriverError(
            f"seide binary not found at {candidate}; build it first with `python tools/build.py`"
        )
    raise DriverError(f"cannot find {argv[0]!r} (from --seide {setting!r})")


def resolve_endpoint(args) -> tuple:
    """Return ``(argv, mode)`` for ``--seide`` (kernel) or ``--seide-cmd`` (full).

    *kernel* mode appends the ``rpc`` subcommand to the kernel binary; *full*
    mode runs ``--seide-cmd`` exactly as given, because the caller already wrote
    the whole command line (``rpc`` included).  ``--seide`` defaults to the
    kernel binary only when it is absent, so an explicitly written ``--seide``
    is still detected as a conflict with ``--seide-cmd``.
    """
    if args.seide_cmd:
        if args.seide is not None:
            raise DriverError("--seide and --seide-cmd are mutually exclusive")
        argv = split_command(args.seide_cmd)
        if not argv:
            raise DriverError("--seide-cmd is empty")
        if not (Path(argv[0]).is_file() or shutil.which(argv[0])):
            raise DriverError(f"cannot find {argv[0]!r} (from --seide-cmd)")
        return argv, "full"
    seide = args.seide if args.seide is not None else KERNEL_DEFAULT
    argv = resolve_argv(seide, explicit=args.seide is not None)
    return [*argv, "rpc"], "kernel"


class RpcClient:
    """Line-delimited JSON-RPC client for a child process."""

    def __init__(self, argv, timeout: float):
        self.argv = list(argv)
        self.timeout = timeout
        self.proc = None
        self._cv = threading.Condition()
        self._responses = {}
        self._events = []
        self._ids = itertools.count(1)
        self._closed = None
        self._stderr_tail = collections.deque(maxlen=40)
        self._threads = []

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "RpcClient":
        """Spawn the child and start pumping its stdout/stderr."""
        try:
            self.proc = subprocess.Popen(
                self.argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(REPO_ROOT),
            )
        except OSError as exc:
            raise DriverError(f"cannot start {self.argv[0]!r}: {exc}") from exc
        for target in (self._pump_stdout, self._pump_stderr):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def close(self) -> None:
        """Shut the child down: close stdin, wait, then kill if it lingers."""
        proc = self.proc
        if proc is None:
            return
        with self._cv:
            if self._closed is None:
                self._closed = "driver closed the session"
            self._cv.notify_all()
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        for thread in self._threads:
            thread.join(timeout=1)

    # -- reader threads ----------------------------------------------------

    def _pump_stdout(self) -> None:
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                self._dispatch(raw)
        finally:
            code = self.proc.poll()
            self._finish(
                "the kernel closed its stdout" if code is None else f"the kernel exited with code {code}"
            )

    def _pump_stderr(self) -> None:
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self._stderr_tail.append(line)

    def _dispatch(self, raw: bytes) -> None:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            message = None
        with self._cv:
            if isinstance(message, dict) and message.get("id") is not None:
                self._responses[message["id"]] = message
            elif isinstance(message, dict) and "event" in message:
                self._events.append(message)
            else:
                self._events.append({"_malformed": line})
            self._cv.notify_all()

    def _finish(self, reason: str) -> None:
        with self._cv:
            if self._closed is None:
                self._closed = reason
            self._cv.notify_all()

    def _dead_message(self, what: str) -> str:
        message = f"the kernel died before {what} ({self._closed})"
        if self._stderr_tail:
            message += "\nkernel stderr:\n  " + "\n  ".join(self._stderr_tail)
        return message

    def stderr_tail(self) -> str:
        """The kernel's recent stderr, for failure reports."""
        return "\n".join(self._stderr_tail)

    # -- protocol ----------------------------------------------------------

    def send(self, message: dict) -> None:
        """Write one JSON message plus a newline to the child's stdin."""
        payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()
        except (OSError, ValueError) as exc:
            raise DriverError(f"cannot write to the kernel: {exc}") from exc

    def _await(self, getter, what: str, budget: float):
        """Block until *getter()* returns something truthy or *budget* expires."""
        deadline = time.monotonic() + budget
        with self._cv:
            while True:
                value = getter()
                if value is not None:
                    return value
                if self._closed is not None:
                    raise DriverError(self._dead_message(what))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DriverError(f"timed out after {budget:g}s waiting for {what}")
                self._cv.wait(remaining)

    def exchange(self, method: str, params=None, timeout: float = None) -> dict:
        """Send one request and return the whole response message."""
        request_id = next(self._ids)
        budget = self.timeout if timeout is None else timeout
        self.send({"id": request_id, "method": method, "params": params if params is not None else {}})
        return self._await(
            lambda: self._responses.pop(request_id, None), f"the response to {method}", budget
        )

    def call(self, method: str, params=None, timeout: float = None):
        """Send a request and return its ``result``, raising :class:`RpcError`."""
        message = self.exchange(method, params, timeout)
        if "error" in message:
            error = message["error"]
            if not isinstance(error, dict):
                error = {"code": "ERROR", "message": str(error)}
            raise RpcError(
                str(error.get("name", error.get("code", "ERROR"))),
                str(error.get("message", "")),
                error,
            )
        if "result" not in message:
            raise CheckFailed(f"{method}: response has neither result nor error")
        return message["result"]

    def expect_error(self, method: str, params=None, timeout: float = None) -> dict:
        """Send a request that must fail, returning its error object."""
        message = self.exchange(method, params, timeout)
        error = message.get("error")
        if not isinstance(error, dict):
            raise CheckFailed(f"{method}: expected an error, got {_short(message)}")
        return error

    def wait_event(self, predicate, what: str, timeout: float = None) -> dict:
        """Return and consume the first queued event satisfying *predicate*."""
        budget = self.timeout if timeout is None else timeout

        def grab():
            for index, event in enumerate(self._events):
                if predicate(event):
                    return self._events.pop(index)
            return None

        return self._await(grab, what, budget)


def _short(value, limit: int = 300) -> str:
    """Compact repr of a value for failure messages."""
    text = json.dumps(value, separators=(",", ":"), default=str)
    return text if len(text) <= limit else text[:limit] + "..."


def _is_id(value) -> bool:
    """True for a revision/run id: an int or non-empty string, but not a bool."""
    if isinstance(value, bool):
        return False
    return (isinstance(value, int)) or (isinstance(value, str) and value != "")


def require(condition, message: str) -> None:
    """Raise :class:`CheckFailed` unless *condition* is true."""
    if not condition:
        raise CheckFailed(message)


# --------------------------------------------------------------------------
# Fixture handling


def resolve_fixture(explicit) -> dict:
    """Decide which Brainfuck program the checks use.

    Returns a dict with ``path`` (absolute), ``text`` and ``expected`` (the bytes
    the program should print, computed with the bundled interpreter).
    """
    hello = REPO_ROOT / "examples" / "hello.bf"
    shadow = REPO_ROOT / "examples" / "shadow.bf"
    created = False

    if explicit:
        path = Path(explicit)
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if not path.is_file():
            raise DriverError(f"--fixture is not a readable file: {path}")
    elif hello.is_file():
        path = hello
    elif shadow.is_file():
        path = shadow
    else:
        path = shadow
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(INLINE_LF, encoding="utf-8", newline="\n")
            created = True
        except OSError as exc:
            raise DriverError(f"cannot create the scratch fixture {path}: {exc}") from exc

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise DriverError(f"cannot read fixture {path}: {exc}") from exc
    return {"path": str(path), "text": text, "created": created, "inline": path == shadow and created}


def expected_output(path: str, fallback: str) -> str:
    """Run the bundled ``bf.py`` over the fixture to learn its expected stdout."""
    if BF_PY.is_file():
        try:
            done = subprocess.run(
                [sys.executable, str(BF_PY), path], capture_output=True, timeout=60, check=False
            )
            if done.returncode == 0:
                return done.stdout.decode("utf-8", "replace")
            raise DriverError(
                f"bf.py failed on {path} (exit {done.returncode}): "
                f"{done.stderr.decode('utf-8', 'replace').strip()}"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise DriverError(f"cannot derive the expected output from {path}: {exc}") from exc
    return fallback


# --------------------------------------------------------------------------
# The scenario


class Harness:
    """Runs the named checks and records their outcomes."""

    def __init__(self, client: RpcClient, ctx: dict, style: Style, keep_going: bool, stream):
        self.client = client
        self.ctx = ctx
        self.style = style
        self.keep_going = keep_going
        self.stream = stream
        self.results = []

    def run(self, name: str, check) -> bool:
        """Execute one check, printing a PASS/FAIL line; never raises."""
        try:
            detail = check() or "ok"
            passed = True
        except (CheckFailed, RpcError, DriverError) as exc:
            detail, passed = str(exc).replace("\n", " "), False
        except Exception as exc:  # noqa: BLE001 - a driver bug is still a failing check
            detail, passed = f"{type(exc).__name__}: {exc}", False
        self.results.append(
            {"name": name, "ok": passed, "detail": detail, "skipped": False, "mode_skip": False}
        )
        tag = self.style.ok("PASS") if passed else self.style.bad("FAIL")
        print(f"[{tag}] {name}: {self.style.dim(detail)}", file=self.stream, flush=True)
        return passed

    def skip(self, name: str, reason: str) -> None:
        """Record a check this endpoint mode does not serve (never a failure)."""
        self.results.append(
            {"name": name, "ok": False, "detail": reason, "skipped": False, "mode_skip": True}
        )
        print(f"[{self.style.dim('SKIP')}] {name}: {self.style.dim(reason)}", file=self.stream, flush=True)


def build_board(ctx: dict) -> dict:
    """The board payload the round-trip check saves and loads.

    The frozen card vocabulary is ``{id, kind, x, y, w, h, z, title, ...}``, plus
    ``links: [{id, from, to, label}]``.  An editor card binds a *file path*; the
    text itself lives in the file, never in the card.

    ``kind`` is deliberately open, and since seide/2 the kernel does not even
    police the card *shape*: a document is opaque bytes to the kernel, so this
    payload's job is to prove the round-trip is exact rather than to prove the
    kernel can read it.  The third card below is a ``sheet`` card whose state is
    a nested object of typed columns and rows, not a string.  If anything in the
    path lost, reshaped or re-ordered that, the deep comparison in
    ``board_roundtrip`` fails.
    """
    return {
        "version": 1,
        "cards": [
            {
                "id": "e2e-editor",
                "kind": "editor",
                "x": 40,
                "y": 60,
                "w": 640,
                "h": 420,
                "z": 1,
                "title": "e2e scratch",
                "file": ctx["fixture_path"],
            },
            {
                "id": "e2e-note",
                "kind": "note",
                "x": 720,
                "y": 60,
                "w": 320,
                "h": 200,
                "z": 2,
                "title": "e2e notes",
            },
            {
                "id": "e2e-sheet",
                "kind": "sheet",
                "x": 720,
                "y": 300,
                "w": 460,
                "h": 320,
                "z": 3,
                "title": "e2e structured state",
                "doc": {
                    "columns": [
                        {"id": "key", "title": "key", "type": "text"},
                        {"id": "count", "title": "count", "type": "number"},
                        {"id": "done", "title": "done", "type": "bool"},
                        {"id": "mood", "title": "mood", "type": "choice",
                         "options": ["calm", "busy"]},
                    ],
                    "rows": [
                        {"id": "r1",
                         "cells": {"key": "unicode: \u00e9\u4e2d\u6587",
                                   "count": 1.5, "done": True, "mood": "calm"}},
                        {"id": "r2",
                         "cells": {"key": "", "count": 0, "done": False, "mood": "busy"}},
                    ],
                },
            },
        ],
        "links": [
            {"id": "l1", "from": "e2e-editor", "to": "e2e-note", "label": "e2e"},
            {"id": "l2", "from": "e2e-editor", "to": "e2e-sheet", "label": "data"},
        ],
    }


def board_arrays(loaded) -> tuple:
    """Accept ``{cards, links}``, ``{board: ...}`` and the kernel's ``{document: ...}``.

    ``view.load`` answers ``{path, revision, document}``; a client that kept the
    document under ``board`` is tolerated too.
    """
    require(isinstance(loaded, dict), "view.load did not return an object")
    if "cards" in loaded or "links" in loaded:
        return loaded.get("cards"), loaded.get("links")
    for key in ("document", "board"):
        inner = loaded.get(key)
        if isinstance(inner, dict):
            return inner.get("cards"), inner.get("links")
    raise CheckFailed(
        f"view.load returned neither cards, document nor board: {_short(loaded)}"
    )


def normalise_tokens(tokens, text_len: int) -> list:
    """Return ``(start, end, kind)`` triples from either wire shape.

    The shell sends ``[start, end, kind]`` arrays; object tokens are accepted too
    so the check keeps working against an older kernel-side tokenizer.
    """
    spans = []
    for token in tokens:
        if isinstance(token, dict):
            start, end, kind = token.get("start"), token.get("end"), token.get("kind")
        elif isinstance(token, (list, tuple)) and len(token) == 3:
            start, end, kind = token[0], token[1], token[2]
        else:
            raise CheckFailed(f"token is neither [start, end, kind] nor an object: {_short(token)}")
        require(
            isinstance(start, int) and isinstance(end, int) and isinstance(kind, str),
            f"token {_short(token)} needs int start/end and a string kind",
        )
        require(
            0 <= start < end <= text_len,
            f"token span {start}..{end} is outside the {text_len}-byte text",
        )
        spans.append((start, end, kind))
    return spans


def define_checks(h: Harness) -> list:
    """Return the scenario as ``(name, check, requires)`` triples.

    ``requires`` is ``None`` for every endpoint, or ``"full"`` for the language
    services that only the shell multiplexer serves.
    """
    client, ctx = h.client, h.ctx

    def hello():
        result = client.call("hello", {})
        require(isinstance(result, dict), "hello result is not an object")
        require(isinstance(result.get("protocol"), int), "hello.protocol is not an int")
        require(isinstance(result.get("kernel_version"), str), "hello.kernel_version is not a string")
        require(isinstance(result.get("root"), str), "hello.root is not a string")
        ctx["root"] = result["root"]
        return f"protocol={result['protocol']} kernel_version={result['kernel_version']} root={result['root']}"

    def workspace_info():
        info = client.call("workspace.info", {})
        require(isinstance(info, dict), "workspace.info result is not an object")
        require(isinstance(info.get("root"), str), "workspace.info.root is not a string")
        require(isinstance(info.get("file_count"), int), "workspace.info.file_count is not an int")
        # `view_path`/`view_revision` describe the document the *kernel* is
        # holding right now, which -- this early in the run -- is whatever the
        # last process left.  A fresh kernel has read nothing, so an empty path
        # and revision 0 are the honest answer, not a missing member.
        require(isinstance(info.get("view_path"), str),
                "workspace.info.view_path is not a string")
        require(isinstance(info.get("view_revision"), (int, float)),
                "workspace.info.view_revision is not a number")
        if ctx["mode"] == "full":
            langs = info.get("langs")
            require(isinstance(langs, list), "workspace.info.langs is not a list (full mode)")
            require(langs, "workspace.info.langs is empty (full mode)")
            described = f"langs={len(langs)}"
        elif "langs" in info:
            require(isinstance(info.get("langs"), list), "workspace.info.langs is not a list")
            described = f"langs={len(info['langs'])} (not required in kernel mode)"
        else:
            described = "no langs member (kernel mode)"
        return f"root={info['root']} file_count={info['file_count']} {described}"

    def lang_list():
        result = client.call("lang.list", {})
        entries = result.get("langs") if isinstance(result, dict) else None
        require(isinstance(entries, list), "lang.list.langs is not a list")
        by_id = {}
        for entry in entries:
            require(isinstance(entry, dict), f"lang.list entry is not an object: {_short(entry)}")
            for key, kind in (("id", str), ("title", str), ("extensions", list)):
                require(
                    isinstance(entry.get(key), kind),
                    f"lang {entry.get('id')!r}: {key} is not a {kind.__name__}",
                )
            by_id[entry["id"]] = entry
        require("brainfuck" in by_id, f"lang.list has no 'brainfuck' language ({sorted(by_id)})")
        return f"{len(entries)} languages; brainfuck extensions={by_id['brainfuck']['extensions']}"

    def lang_tokenize():
        text = ctx["source_text"]
        result = client.call("lang.tokenize", {"path": ctx["fixture_path"], "text": text})
        require(isinstance(result, dict), "lang.tokenize result is not an object")
        tokens = result.get("tokens")
        require(isinstance(tokens, list), "lang.tokenize.tokens is not a list")
        require(tokens, "lang.tokenize returned no tokens for a Brainfuck program")
        lang = result.get("lang")
        require(lang is None or isinstance(lang, str), "lang.tokenize.lang is neither a string nor null")
        spans = normalise_tokens(tokens, len(text))
        commands = sum(1 for _, _, kind in spans if kind == "command")
        require(commands > 0, "no token of kind 'command' in a Brainfuck program")
        ctx["tokens"] = spans
        return f"{len(spans)} tokens, {commands} of kind 'command', lang={lang!r}"

    def lang_tiling():
        """Spans must tile the input: start at 0, no gap, no overlap, end at length."""
        text = ctx["source_text"]
        result = client.call("lang.tokenize", {"path": ctx["fixture_path"], "text": text})
        tokens = result.get("tokens") if isinstance(result, dict) else None
        require(isinstance(tokens, list) and tokens, "lang.tokenize returned no tokens")
        spans = normalise_tokens(tokens, len(text))
        cursor = 0
        for index, (start, end, kind) in enumerate(spans):
            require(
                start == cursor,
                f"tiling broke at token {index} ({kind}): starts at {start}, expected {cursor}",
            )
            cursor = end
        require(
            cursor == len(text),
            f"spans stop tiling at {cursor}, but the input is {len(text)} bytes long",
        )
        return f"{len(spans)} spans tile 0..{len(text)} with no gaps or overlaps"

    def file_read():
        result = client.call("file.read", {"path": ctx["fixture_path"]})
        require(isinstance(result, dict), "file.read result is not an object")
        # Hand the text and revision to the write checks before judging anything
        # else, so one unmet expectation cannot cascade into them.
        require(isinstance(result.get("text"), str), "file.read.text is not a str")
        require(_is_id(result.get("revision")), "file.read.revision is not an int or string")
        ctx["revision"] = result["revision"]
        ctx["file_text"] = result["text"]
        required = [("path", str), ("eol", str), ("size", int), ("mtime", int)]
        if ctx["mode"] == "full":
            # Only the shell knows languages; the kernel has no language layer.
            required.append(("lang", str))
        for key, kind in required:
            require(isinstance(result.get(key), kind), f"file.read.{key} is not a {kind.__name__}")
        require(
            result["eol"] in ("lf", "crlf"),
            f"file.read.eol is {result['eol']!r}, expected 'lf' or 'crlf'",
        )
        if ctx["mode"] != "full" and "lang" in result:
            require(isinstance(result["lang"], str), "file.read.lang is not a str")
        described = f"revision={result['revision']} eol={result['eol']!r} size={result['size']}"
        if isinstance(result.get("lang"), str):
            described += f" lang={result['lang']}"
        return described

    def _write_fixture(text, base_revision):
        """Write ``text`` to the fixture and return the resulting revision."""
        result = client.call(
            "file.write",
            {"path": ctx["fixture_path"], "text": text, "base_revision": base_revision},
        )
        require(isinstance(result, dict), "file.write result is not an object")
        revision = result.get("revision")
        require(_is_id(revision), "file.write.revision is not an int or string")
        return revision

    def _restore_fixture(text):
        """Put the fixture's original bytes back, whatever revision it is at now.

        Called from ``finally`` blocks, where the file may have been moved on by
        a concurrent editor or by the check's own first write, so the base
        revision is re-read instead of remembered.  A restore that cannot run
        must never mask the failure it was cleaning up after, but it must not be
        silent either.
        """
        try:
            current = client.call("file.read", {"path": ctx["fixture_path"]})["revision"]
            client.call(
                "file.write",
                {"path": ctx["fixture_path"], "text": text, "base_revision": current},
            )
        except Exception as exc:  # noqa: BLE001 -- a restore may never raise
            sys.stderr.write(
                f"seIDE e2e: could not restore {ctx['fixture_path']}: {exc}\n"
            )

    def file_write():
        require(ctx.get("file_text") is not None, "file.read provided no text to write back")
        original, base = ctx["file_text"], ctx["revision"]
        # The revision is a content hash, so rewriting the same bytes would hand
        # back the base revision and prove nothing: make a real edit instead.
        edited = _write_fixture(original + REVISION_PROBE, base)
        try:
            require(
                edited != base,
                f"file.write of changed text returned the base revision {base}",
            )
            # Leave the workspace byte-identical to how it was found; identical bytes
            # hash back to the original revision, which is what proves the restore.
            restored = _write_fixture(original, edited)
            require(
                restored == base,
                f"restoring the original bytes gave revision {restored}, expected {base}",
            )
        finally:
            # The probe text is ours, not the developer's: if anything above
            # raised -- a stale revision because an editor, a formatter or a
            # `git checkout` touched the file mid-check -- the fixture must not
            # be left carrying it.  This is the same contract the sibling
            # checks already keep.
            _restore_fixture(original)
        return f"revision {base} -> {edited} -> {restored} (edited then restored)"

    def file_write_stale():
        require(ctx.get("file_text") is not None, "file.read provided no text to write back")
        original, base = ctx["file_text"], ctx["revision"]
        # Move the file on with one write, then offer the revision we read before
        # that write as the base of the next one, which must be refused.
        current = _write_fixture(original + REVISION_PROBE, base)
        try:
            error = client.expect_error(
                "file.write",
                {"path": ctx["fixture_path"], "text": original, "base_revision": base},
            )
            # The kernel names the error in `name` and numbers it in `code`; a
            # string `code` is accepted too so the check survives either spelling.
            code = error.get("name", error.get("code"))
            require(
                code == "STALE_REVISION",
                f"stale write reported {code!r} (code={error.get('code')!r}), "
                "expected 'STALE_REVISION'",
            )
            data = error.get("data")
            require(
                isinstance(data, dict) and "current_revision" in data,
                "STALE_REVISION carries no data.current_revision",
            )
            require(
                _is_id(data["current_revision"]),
                "STALE_REVISION data.current_revision is not an int or string",
            )
            require(
                data["current_revision"] == current,
                f"STALE_REVISION reports current_revision={data['current_revision']!r}, "
                f"but the file is at {current!r}",
            )
            detail = (
                f"stale base_revision={base} rejected with {code} "
                f"(current {data['current_revision']})"
            )
        finally:
            # Restore the fixture even if the expectation above did not hold.
            _write_fixture(original, current)
        return detail

    def path_containment():
        """A path outside the workspace root is refused, in both spellings.

        The fixture lives inside the root, so the escape target is a sibling of
        the repository directory: it is never created and never has to exist,
        because containment is decided before the file is looked up.
        """
        outside = str(REPO_ROOT.parent / "e2e-outside.bf")
        for label, path in (("absolute", outside), ("relative", "../e2e-outside.bf")):
            error = client.expect_error("file.read", {"path": path})
            code = error.get("code")
            require(
                code == 1003 or str(code) == "1003",
                f"{label} escape {path!r} reported code={code!r} "
                f"name={error.get('name')!r}, expected 1003",
            )
        return f"absolute and relative escapes both refused with 1003 (e.g. {outside})"

    def board_state():
        """Read the live board so a check that saves one can put it back.

        The board is project state, not test scratch space: a suite that
        silently discards where the developer put everything is testing the
        wrong product.  The **whole** document is kept, not just the two arrays
        this suite happens to know about -- rebuilding it by hand is exactly how
        the viewport (where the developer put the camera) got reset on every
        run, silently and with exit 0.

        The kernel answers with the document it is holding, so "was there one
        before the run" is not something its reply can say: this suite reads the
        path it named itself.  That is the point of the split -- the client owns
        the path, the kernel owns the bytes.
        """
        loaded = client.call("view.load", {"path": DOCUMENT_PATH})
        document = loaded.get("document") if isinstance(loaded, dict) else None
        absolute = os.path.join(ctx["root"], DOCUMENT_PATH.replace("/", os.sep))
        return {
            "document": (
                json.loads(json.dumps(document)) if isinstance(document, dict) else None
            ),
            "path": absolute,
            "existed": os.path.exists(absolute),
        }

    def board_restore(state):
        """Put the board back, or remove the one the suite created."""
        if state["document"] is None:
            return
        if state["existed"]:
            client.call("view.save", {"path": DOCUMENT_PATH, "document": state["document"]})
        elif state["path"] and os.path.basename(state["path"]) == "board.json":
            # No board before the run, none after it either -- and no empty
            # state directory left behind where the board used to be.
            os.remove(state["path"])
            try:
                os.rmdir(os.path.dirname(state["path"]))
            except OSError:
                pass  # something else lives there, or it was never created

    def board_roundtrip():
        state = board_state()
        try:
            board = build_board(ctx)
            saved = client.call("view.save", {"path": DOCUMENT_PATH, "document": board})
            require(isinstance(saved, dict), "view.save result is not an object")
            require(_is_id(saved.get("revision")), "view.save.revision is not an int or string")
            require(saved.get("saved") is True, "view.save.saved is not true")
            loaded = client.call("view.load", {"path": DOCUMENT_PATH})
            cards, links = board_arrays(loaded)
            require(
                cards == board["cards"],
                f"cards did not round-trip: sent {_short(board['cards'])} got {_short(cards)}",
            )
            require(
                links == board["links"],
                f"links did not round-trip: sent {_short(board['links'])} got {_short(links)}",
            )
            # The document travels under one name.  A client that puts it
            # somewhere else gets an answer, not a silently stored nothing.
            error = client.expect_error(
                "view.save", {"path": DOCUMENT_PATH, "board": board}
            )
            code = error.get("name", error.get("code"))
            require(
                code == "INVALID_PARAMS",
                f"a document under the wrong member was refused with {code!r}",
            )
            detail = (
                f"{len(cards)} cards and {len(links)} links round-tripped exactly "
                f"(revision {saved['revision']})"
            )
        finally:
            try:
                board_restore(state)
            except Exception:
                pass

        return detail

    def starter_board():
        """The board shipped for a fresh clone must survive the store untouched.

        `examples/board.json` is what `tools/demo.py` installs into a new
        workspace, and it is the board the README's screenshots show.  The
        kernel no longer validates it -- a document's shape is the client's
        business, and the client's reader lives in `shell/web/board.mjs` -- so
        what this check can still prove is the other half of the contract: the
        shipped bytes, viewport included, come back exactly as they went in.
        A starter board that a *client* would mangle is caught where the client
        runs: `shell/web/selftest.mjs` and `make smoke`.
        """
        path = REPO_ROOT / "examples" / "board.json"
        require(path.is_file(), f"{path} is missing")
        with open(path, "rb") as handle:
            raw = handle.read()
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            require(False, f"{path} is not UTF-8 JSON: {exc}")
        require(isinstance(document, dict), f"{path} is not an object")
        cards = document.get("cards")
        links = document.get("links")
        require(isinstance(cards, list) and cards, f"{path} carries no cards")
        require(isinstance(links, list), f"{path} carries no links array")

        state = board_state()
        try:
            saved = client.call(
                "view.save", {"path": DOCUMENT_PATH, "document": document}
            )
            require(isinstance(saved, dict), "the starter board was not accepted")
            require(saved.get("saved") is True, "the starter board was not saved")
            loaded = client.call("view.load", {"path": DOCUMENT_PATH})
            got_cards, got_links = board_arrays(loaded)
            require(
                got_cards == cards,
                f"starter cards did not round-trip: sent {len(cards)}, got {_short(got_cards)}",
            )
            require(
                got_links == links,
                f"starter links did not round-trip: sent {len(links)}, got {_short(got_links)}",
            )
            kept = loaded.get("document") if isinstance(loaded, dict) else {}
            viewport = kept.get("viewport") if isinstance(kept, dict) else None
            require(
                viewport == document.get("viewport"),
                f"the starter viewport did not survive: sent {document.get('viewport')!r} "
                f"got {viewport!r}",
            )
        finally:
            try:
                board_restore(state)
            except Exception:
                pass
        return (
            f"{len(cards)} cards and {len(links)} links from {len(raw)} shipped bytes "
            "accepted and stored exactly"
        )

    def proc_run():
        result = client.call("proc.start", {"cmd": ctx["cmd"], "cwd": ctx["cwd"]})
        require(isinstance(result, dict), "proc.start result is not an object")
        run_id = result.get("run_id")
        require(_is_id(run_id), "proc.start.run_id is not an int or string")

        def belongs(event):
            if event.get("event") not in ("proc.output", "proc.exit"):
                return False
            return event.get("run_id", run_id) == run_id

        deadline = time.monotonic() + client.timeout
        stdout, stderr, finished, exit_code = bytearray(), bytearray(), False, None
        while not finished:
            remaining = deadline - time.monotonic()
            require(remaining > 0, f"run {run_id} produced no proc.exit within {client.timeout:g}s")
            event = client.wait_event(belongs, f"proc.output/proc.exit for run {run_id}", remaining)
            if event["event"] == "proc.output":
                channel = str(event.get("stream", event.get("channel", "stdout")))
                data = event.get("data", event.get("text", ""))
                (stderr if channel == "stderr" else stdout).extend(str(data).encode("utf-8", "replace"))
            else:
                exit_code = event.get("code", event.get("exit_code"))
                finished = True

        text = stdout.decode("utf-8", "replace")
        require(
            exit_code == 0,
            f"run {run_id} exited with {exit_code!r}; stderr={stderr[:200].decode('utf-8', 'replace')!r}",
        )
        require(
            ctx["expected"] in text,
            f"stdout {text[:200]!r} does not contain the expected output {ctx['expected']!r}",
        )
        return f"run {run_id} exit 0, stdout {text!r}"

    def proc_duplex():
        """Both directions of the channel, and the end of one of them.

        `core/include/exec.h` used to hand every child the NUL device as its
        standard input, so nothing could ever be *sent*.  A language server is
        the case that forced the pipe: without a write path there are no
        subsystems, only runners.
        """
        script = REPO_ROOT / "build" / "__e2e_duplex.py"
        script.write_bytes(
            b"import sys\n"
            b"data = sys.stdin.read()\n"
            b"sys.stdout.write('got:' + data.strip() + '\\n')\n"
            b"sys.stdout.flush()\n"
            b"sys.exit(7)\n"
        )
        try:
            started = client.call("proc.start", {"cmd": f'"{sys.executable}" "{script}"'})
            require(isinstance(started, dict), "proc.start result is not an object")
            run_id = started.get("run_id")
            require(_is_id(run_id), "proc.start.run_id is not an int or string")

            written = client.call("proc.send", {"run_id": run_id, "data": "hello-channel\n"})
            require(
                isinstance(written, dict) and written.get("written") == len("hello-channel\n"),
                f"proc.send wrote {written!r}; expected {len('hello-channel\n')} bytes",
            )

            listed = client.call("proc.list")
            runs = listed.get("runs") if isinstance(listed, dict) else None
            require(isinstance(runs, list), "proc.list did not return a `runs` array")
            require(
                any(run.get("run_id") == run_id for run in runs if isinstance(run, dict)),
                f"run {run_id} is not in proc.list: {runs!r}",
            )
            require(
                all("card_id" not in run for run in runs if isinstance(run, dict)),
                f"proc.list still mentions a card: {runs!r}",
            )

            closed = client.call("proc.close", {"run_id": run_id})
            require(
                isinstance(closed, dict) and closed.get("closed") is True,
                f"proc.close answered {closed!r}",
            )
            refused = client.expect_error(
                "proc.send", {"run_id": run_id, "data": "too late\n"}
            )
            require(
                str(refused.get("name", refused.get("code"))) == "PROC",
                f"proc.send after proc.close was answered with {refused!r}, expected the PROC code",
            )

            def belongs(event):
                return (
                    event.get("event") in ("proc.output", "proc.exit")
                    and event.get("run_id", run_id) == run_id
                )

            deadline = time.monotonic() + client.timeout
            text, exit_code, finished = bytearray(), None, False
            while not finished:
                remaining = deadline - time.monotonic()
                require(remaining > 0, f"run {run_id} produced no proc.exit after proc.close")
                event = client.wait_event(belongs, f"proc.output/proc.exit for run {run_id}", remaining)
                if event["event"] == "proc.output":
                    text.extend(str(event.get("data", "")).encode("utf-8", "replace"))
                else:
                    exit_code = event.get("code")
                    finished = True
            require(
                exit_code == 7,
                f"run {run_id} exited with {exit_code!r}, expected the script's 7",
            )
            require(
                "got:hello-channel" in text.decode("utf-8", "replace"),
                f"the child did not echo what proc.send wrote: {bytes(text)[:200]!r}",
            )
            return f"run {run_id} echoed {len(text)} byte(s) of stdin and exited 7"
        finally:
            if script.exists():
                script.unlink()

    def lang_tokenize_sgml():
        """The SGML family has to survive the same path Brainfuck does.

        Nothing here is Brainfuck-shaped: detection is by extension, the scanner
        is `langs/markup.mjs`, and the token kinds must still tile the file.
        """
        path = "examples/page.html"
        read = client.call("file.read", {"path": path})
        require(isinstance(read, dict), f"file.read of {path} returned no object")
        text = read.get("text")
        require(isinstance(text, str) and text, f"{path} is empty or unreadable")
        require(
            read.get("lang") == "html",
            f"file.read detected lang={read.get('lang')!r} for {path}, expected 'html'",
        )
        result = client.call("lang.tokenize", {"path": path, "text": text})
        require(isinstance(result, dict), "lang.tokenize result is not an object")
        require(
            result.get("lang") == "html",
            f"lang.tokenize resolved lang={result.get('lang')!r} for {path}",
        )
        spans = normalise_tokens(result.get("tokens") or [], len(text))
        kinds = {kind for _, _, kind in spans}
        for wanted in ("keyword", "type", "string", "comment"):
            require(wanted in kinds, f"no {wanted!r} span in {path}: {sorted(kinds)}")
        cursor = 0
        for start, end, _ in spans:
            require(start == cursor, f"{path}: spans do not tile (gap or overlap at {cursor})")
            cursor = end
        require(cursor == len(text), f"{path}: spans stop at {cursor}, not {len(text)}")
        return f"{len(spans)} tokens over {len(text)} bytes, kinds={sorted(kinds)}"

    return [
        ("hello", hello, None),
        ("workspace.info", workspace_info, None),
        ("lang.list", lang_list, "full"),
        ("lang.tokenize", lang_tokenize, "full"),
        ("lang.tokenize tiling", lang_tiling, "full"),
        ("lang.tokenize sgml", lang_tokenize_sgml, "full"),
        ("file.read", file_read, None),
        ("file.write", file_write, None),
        ("file.write stale revision", file_write_stale, None),
        ("file.read path containment", path_containment, None),
        ("view.save/view.load round-trip", board_roundtrip, None),
        ("starter board", starter_board, None),
        ("proc.start run", proc_run, None),
        ("proc duplex channel", proc_duplex, None),
    ]


def run_scenario(client: RpcClient, ctx: dict, style: Style, keep_going: bool, stream):
    """Run every check, stopping at the first failure unless *keep_going*."""
    harness = Harness(client, ctx, style, keep_going, stream)
    checks = define_checks(harness)
    for index, (name, check, requires) in enumerate(checks):
        if requires == "full" and ctx["mode"] != "full":
            harness.skip(name, "kernel mode: languages are served by the shell, not the kernel")
            continue
        if not harness.run(name, check) and not keep_going:
            for skipped_name, _, _ in checks[index + 1:]:
                harness.results.append(
                    {
                        "name": skipped_name,
                        "ok": False,
                        "detail": "not run",
                        "skipped": True,
                        "mode_skip": False,
                    }
                )
            break
    return harness.results


def report(results, style: Style, stream, extra: str = "") -> int:
    """Print the summary and return the process exit code."""
    passed = [item for item in results if item["ok"] and not item.get("mode_skip")]
    failed = [
        item
        for item in results
        if not item["ok"] and not item.get("skipped") and not item.get("mode_skip")
    ]
    stopped = [item for item in results if item.get("skipped")]
    mode_skipped = [item for item in results if item.get("mode_skip")]
    parts = [style.ok(f"{len(passed)} passed"), style.bad(f"{len(failed)} failed")]
    skipped_text = f"{len(stopped) + len(mode_skipped)} skipped"
    if mode_skipped:
        skipped_text += f" ({len(mode_skipped)} not served in this mode)"
    parts.append(skipped_text)
    print(f"summary: {', '.join(parts)} ({len(results)} checks)", file=stream, flush=True)
    if stopped:
        print(style.dim("stopped after the first failure; re-run with --keep-going"), file=stream)
    if extra:
        print(style.dim("kernel stderr (tail):"), file=stream)
        for line in extra.splitlines()[-20:]:
            print(style.dim(f"  {line}"), file=stream)
    return 0 if (not failed and not stopped and passed) else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="e2e.py",
        description="Drive the seIDE kernel RPC scenario. Exit codes: 0 pass, 1 fail, 2 driver error, 3 usage.",
    )
    parser.add_argument(
        "--seide",
        default=None,
        metavar="PATH",
        help=f"kernel binary, spawned as `<PATH> rpc` (default {KERNEL_DEFAULT})",
    )
    parser.add_argument(
        "--seide-cmd",
        metavar="CMD",
        help='full endpoint command line, spawned verbatim, e.g. "node shell/main.mjs rpc --workspace ."',
    )
    parser.add_argument("--fixture", metavar="PATH", help="Brainfuck program used by the checks")
    parser.add_argument(
        "--timeout", type=float, default=15.0, metavar="SEC", help="per-request timeout (default 15)"
    )
    parser.add_argument("--keep-going", action="store_true", help="run every check after a failure")
    parser.add_argument("--json", action="store_true", help="write the report as JSON on stdout")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    stream = sys.stderr if args.json else sys.stdout
    style = Style(colour_enabled(stream))
    started = time.monotonic()

    def fail_start(message: str) -> int:
        print(f"e2e.py: {message}", file=sys.stderr)
        if args.json:
            print(json.dumps({"ok": False, "error": message}, indent=2))
        return 2

    try:
        argv_seide, mode = resolve_endpoint(args)
        fixture = resolve_fixture(args.fixture)
        expected = expected_output(
            fixture["path"], "hi" if fixture["inline"] or fixture["path"].endswith("shadow.bf") else ""
        )
        if not expected:
            raise DriverError(f"cannot determine the expected output of {fixture['path']}")
    except DriverError as exc:
        return fail_start(str(exc))

    ctx = {
        "mode": mode,
        "fixture_path": fixture["path"],
        "source_text": fixture["text"],
        "expected": expected,
        "cwd": str(REPO_ROOT),
        "cmd": PROC_TEMPLATE.format(python=sys.executable, bf=str(BF_PY), fixture=fixture["path"]),
    }

    if not args.json:
        print(style.bold(f"seIDE e2e [{mode} mode]: {' '.join(argv_seide)}"))
        print(style.dim(f"fixture   : {fixture['path']}{' (created)' if fixture['created'] else ''}"))
        print(style.dim(f"expected  : {expected!r}"))
        print(style.dim(f"proc cmd  : {ctx['cmd']}"))
        if mode == "kernel":
            print(style.dim("note      : kernel mode skips lang.list / lang.tokenize"))
        print(style.dim("-" * 68))

    client = RpcClient(argv_seide, args.timeout)
    results, stderr_tail = [], ""
    try:
        client.start()
        results = run_scenario(client, ctx, style, args.keep_going, stream)
    except DriverError as exc:
        stderr_tail = client.stderr_tail()
        if not results:
            return fail_start(str(exc))
        print(style.bad(f"FAIL driver: {exc}"), file=stream)
    except KeyboardInterrupt:
        print(style.bad("interrupted"), file=stream)
        return 130
    finally:
        client.close()

    stderr_tail = stderr_tail or client.stderr_tail()
    code = report(results, style, stream, stderr_tail)

    if args.json:
        passed = sum(1 for item in results if item["ok"] and not item.get("mode_skip"))
        failed = sum(
            1
            for item in results
            if not item["ok"] and not item.get("skipped") and not item.get("mode_skip")
        )
        skipped = sum(1 for item in results if item.get("skipped") or item.get("mode_skip"))
        print(
            json.dumps(
                {
                    "ok": code == 0,
                    "mode": mode,
                    "endpoint": argv_seide,
                    "fixture": fixture["path"],
                    "duration_s": round(time.monotonic() - started, 3),
                    "passed": passed,
                    "failed": failed,
                    "skipped": skipped,
                    "checks": results,
                },
                indent=2,
            )
        )
    return code


if __name__ == "__main__":
    sys.exit(main())
