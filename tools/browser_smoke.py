#!/usr/bin/env python3
"""browser_smoke.py -- the real-browser smoke test for the seIDE board UI.

    python tools/browser_smoke.py [--port N] [--edge PATH] [--timeout S] [--keep]

Every other check in this repository speaks to the kernel over stdin/stdout
(``tools/e2e.py``) or imports the browser modules under Node
(``shell/web/selftest.mjs``).  Neither can see the one thing a user actually
looks at: the served page, the HUD the shell paints into it, and the board the
kernel hands back.  This script closes that gap with the smallest possible
machine: the host is started exactly as a developer starts it, the system
browser fetches the page with ``--dump-dom`` (no web driver, no CDP, no
websocket -- the tool this repository already uses for its screenshots), and
every assertion is a substring of the DOM the browser itself produced.

What it proves, in order:

1. ``kernel ready``  -- boot reached the kernel.  The status span only carries
   that text after ``client.ready()`` resolved, so it is the HUD telling the
   truth about a live ``POST /rpc``, not a static label in ``index.html``
   (which ships the empty string).
2. ``workspace <root>``  -- the resolved workspace root was reported and is on
   the page.  The negative half is the load-bearing one: the string ``was not
   reported by the kernel`` must be ABSENT.  That sentence is what the project
   panel paints when it mounts before ``workspace.info`` resolves; a real
   defect shipped once where the panel was drawn early and then never
   repainted, so the panel and the HUD disagreed about which project was open.
3. the board painted -- ``.seide/board.json`` is read as data, its first
   ``editor`` card's ``file`` must appear in the DOM, and (when the board has
   one) the first 40 characters of a ``note`` card's text must appear too.
   Both come from the live board, so this asserts that the *file on disk*
   reached the screen rather than that some hardcoded path did.
4. the command bar shipped -- ``#command`` and ``#command-hint`` are in the DOM
   and the module that defines the command vocabulary (``COMMAND_HELP`` in
   ``shell/web/cards.mjs``, imported by ``main.mjs`` at load time) ran to
   completion.  This is the weakest of the five; the PASS line says so
   explicitly, and the honesty notes below explain why.

Housekeeping, because this script drives the developer's real workspace:

* the host is a ``subprocess.Popen`` whose exact pid is terminated in a
  ``finally`` -- never a blanket kill of ``node``, which would take the
  harness's own node down with it;
* ``.seide/board.json`` is snapshotted byte-for-byte before the host starts and
  written back in a ``finally``, and the byte-identity of that restore is
  printed.  The host rewrites that file on any mutation, so a smoke test that
  forgot this would quietly reorder a user's board on every run;
* the port is picked by binding to port 0 and closing the socket, so two
  concurrent runs cannot collide;
* the browser profile is a throwaway directory that is deleted afterwards
  (kept when ``--keep`` was asked, or when the run never produced a DOM and the
  debris is worth inspecting).

Honesty about what is *not* proven here:

* no input is synthesized, so the command-bar hint (``#command-hint``) is empty
  in the dump -- it is filled by a keydown/input listener.  The shipped command
  rows live in a JavaScript array, not in the served markup, so the assertion
  in check 4 is about the *bar and its module* rather than about the hint text,
  and its PASS line names that limit.  It cannot catch a hint that fails to
  populate on a real keystroke.
* ``--dump-dom`` gives one serialized snapshot per browser launch, so text that
  reaches the page as markup is re-escaped (``&`` -> ``&amp;``), and text that
  lives in a ``<textarea>``'s ``value`` property is not serialized at all.  The
  note check names both limits in its failure message rather than papering over
  them.
* only the five assertions above are made.  A green run says the page booted,
  the HUD and the board agree, and the command vocabulary shipped -- not that
  the UI is correct in any wider sense.

Exit codes
    0   every check passed -- or the browser is not installed (a SKIP line)
    1   the browser was available and at least one check failed
    2   the smoke test could not run (host never listened, browser never
        produced a DOM, malformed ``--port``)
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SHELL_MAIN = REPO_ROOT / "shell" / "main.mjs"
BOARD_PATH = REPO_ROOT / ".seide" / "board.json"
STARTER_BOARD = REPO_ROOT / "examples" / "board.json"

#: Where the system browser normally lives on Windows.  ``--edge`` overrides it.
EDGE_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
)

#: Headless flags proven in this repository for screenshots and DOM dumps.
#: ``--virtual-time-budget`` lets the browser run the page's timers as fast as
#: it can and then stop, so ``--dump-dom`` is deterministic instead of a race.
EDGE_FLAGS = (
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1700,1000",
    "--virtual-time-budget=9000",
)

#: The sentence the project panel paints when ``workspace.info`` has not
#: resolved yet.  Its presence in the DOM is the shipped defect, so it is
#: asserted absent rather than merely searched for.
STALE_PANEL_TEXT = "was not reported by the kernel"

#: The HUD state that is only written once the RPC client is actually ready.
READY_TEXT = "kernel ready"

#: The two spellings of the boot log's workspace line.  ``main.mjs`` resolves
#: the flag with Node's own path rules, which render Windows separators as
#: forward slashes (``workspace C:/work/seIDE``), while the flag a developer
#: types -- and the one printed by ``serve`` -- keeps backslashes.  Both are the
#: same root, so both count; see ``workspace_lines``.
WORKSPACE_TEXTS = (
    f"workspace {REPO_ROOT}",
    "workspace " + str(REPO_ROOT).replace("\\", "/"),
)


class DriverError(Exception):
    """The smoke test itself could not run (unusable options, dead host, ...)."""


class CheckFailed(Exception):
    """An assertion about the served page did not hold."""


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"browser_smoke.py: usage error: {message}", file=sys.stderr)
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


def show(label: str, detail=None) -> None:
    """One aligned ``label : detail`` line; the smoke test's only printer."""
    prefix = f"{label:<22}"
    if detail is None or detail == "":
        print(prefix)
        return
    lines = str(detail).splitlines() or [""]
    print(f"{prefix}{lines[0]}")
    pad = " " * len(prefix)
    for line in lines[1:]:
        print(f"{pad}{line}")


def require(condition, message: str) -> None:
    """Raise :class:`CheckFailed` unless *condition* is true."""
    if not condition:
        raise CheckFailed(message)


def _short(text, limit: int = 200) -> str:
    """A single-line, bounded rendering of *text* for a failure message."""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def _close_fds() -> bool:
    """``close_fds`` for the host: Windows needs False to inherit the pipe."""
    return False if os.name == "nt" else True


# --------------------------------------------------------------------------
# the host


def free_port() -> int:
    """Return a port the OS just handed out: bind to 0, read it, release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def terminate(proc, grace: float = 5.0) -> bool:
    """Terminate exactly *proc*; return True once it is gone.

    Tracking the pid is the whole point: ``taskkill /IM node.exe`` (or the
    equivalent) would kill the harness, which runs on node.
    """
    if proc is None or proc.poll() is not None:
        return proc is None or proc.poll() is not None
    proc.terminate()
    try:
        proc.wait(timeout=grace)
        return True
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=grace)
            return True
        except subprocess.TimeoutExpired:
            return False


class Host:
    """The ``node shell/main.mjs serve`` child, started and killed by pid."""

    def __init__(self, port: int, argv=None):
        self.port = int(port)
        self.argv = list(argv) if argv is not None else [
            "node",
            str(SHELL_MAIN),
            "serve",
            "--workspace",
            str(REPO_ROOT),
            "--port",
            str(self.port),
            "--no-open",
        ]
        self.proc = None
        self.url = f"http://127.0.0.1:{self.port}/"
        self._lines = []
        self._ready = threading.Event()
        self._thread = None

    def start(self) -> "Host":
        """Spawn the host and begin draining its output."""
        try:
            self.proc = subprocess.Popen(
                self.argv,
                cwd=str(REPO_ROOT),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                close_fds=_close_fds(),
            )
        except OSError as exc:
            raise DriverError(f"cannot start {self.argv[0]!r}: {exc}") from exc
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()
        return self

    def _drain(self) -> None:
        """Read the host's stdout line by line; flag the address banner.

        The pipe is drained continuously on purpose: a host that blocks writing
        to a full pipe would look like a hang, and the failure would blame the
        browser instead of the plumbing.
        """
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip()
                self._lines.append(line)
                if line.strip().startswith("board ") and "http://" in line:
                    self._ready.set()
        except (OSError, ValueError):
            pass
        finally:
            self._ready.set()

    def wait_ready(self, timeout: float) -> str:
        """Block until the host prints its URL; raise :class:`DriverError`."""
        deadline = time.monotonic() + timeout
        while not self._ready.wait(0.25):
            if self.proc.poll() is not None:
                self._ready.wait(0.2)
                break
            if time.monotonic() >= deadline:
                raise DriverError(
                    f"the host printed no address within {timeout:g}s "
                    f"(exit {self.proc.poll()})\n{self.tail()}"
                )
        self._ready.wait(0.2)
        if self.proc.poll() is not None and not any("http://" in line for line in self._lines):
            raise DriverError(f"the host exited with {self.proc.poll()}\n{self.tail()}")
        return "\n".join(self._lines[-6:])

    def probe(self, timeout: float = 5.0) -> int:
        """GET ``/`` and return the status code; raise when nothing answers."""
        request = urllib.request.Request(self.url, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response.read(2048)
                return int(response.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)
        except (urllib.error.URLError, OSError) as exc:
            raise DriverError(f"GET {self.url} failed: {exc}") from exc

    def close(self) -> bool:
        """Terminate the exact pid and report whether it went away."""
        return terminate(self.proc)

    def tail(self, limit: int = 12) -> str:
        """The host's recent output, for a failure message."""
        return "\n".join(self._lines[-limit:])


# --------------------------------------------------------------------------
# the browser


def find_edge(explicit):
    """Return the browser to drive, or raise :class:`DriverError` when missing."""
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise DriverError(f"--edge is not a readable file: {path}")
        return path
    for candidate in EDGE_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise DriverError("no browser found at " + " or ".join(str(item) for item in EDGE_CANDIDATES))


def _ps_quote(text: str) -> str:
    """Single-quote *text* for PowerShell."""
    return "'" + str(text).replace("'", "''") + "'"


def _kill_stray(profile: Path) -> int:
    """Best-effort sweep of browsers still holding *profile*; returns the count.

    Only reached after a timeout, and always scoped to this run's throwaway
    profile directory -- never a blanket kill by image name.
    """
    if os.name == "nt":
        script = (
            "$p = " + _ps_quote(str(profile)) + "; $n = 0; "
            "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue | "
            "ForEach-Object { if ($_.CommandLine -like \"*$p*\") { "
            "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } }; $n"
        )
        try:
            done = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, timeout=60, check=False,
            )
            return int(done.stdout.decode("utf-8", "replace").strip() or 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            return 0
    try:
        done = subprocess.run(["pkill", "-f", str(profile)], capture_output=True, timeout=30, check=False)
        return 1 if done.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def dump_dom(edge, url: str, profile: Path, timeout: float):
    """Fetch *url* headless and return ``(dom, error)``; exactly one is None.

    ``error`` means the browser could not be run at all, as opposed to
    answering with a page: a leftover profile lock after a timeout is the usual
    cause, and the caller retries rather than reporting a false failure.
    """
    argv = [str(edge), *EDGE_FLAGS, f"--user-data-dir={profile}", "--dump-dom", url]
    try:
        done = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        swept = _kill_stray(profile)
        note = f" (swept {swept} stray browser process(es) on this profile)" if swept else ""
        return None, f"{edge} did not finish within {timeout:g}s{note}"
    except OSError as exc:
        return None, f"cannot run {edge}: {exc}"
    text = done.stdout.decode("utf-8", "replace")
    if not text.strip():
        stderr = _short(done.stderr.decode("utf-8", "replace"), 300)
        suffix = f": {stderr}" if stderr else ""
        return None, f"the browser dumped no DOM (exit {done.returncode}){suffix}"
    return text, None


def dom_of(text: str) -> str:
    """Trim a dump to the markup, dropping any banner lines printed before it."""
    lowered = text.lower()
    for marker in ("<!doctype", "<html"):
        index = lowered.find(marker)
        if index > 0:
            return text[index:]
    return text


def _looks_painted(text: str) -> bool:
    """True when the dump shows a booted page, so a retry cannot improve it.

    Deliberately narrow: the HUD reached the ready state *and* some card markup
    exists.  A dump that only got as far as ``connecting...`` is worth retrying.
    """
    return READY_TEXT in text and "card-title" in text


def grab_dom(edge, url: str, profile: Path, timeout: float, budget: float):
    """Keep dumping until the page looks painted, or *budget* seconds elapse.

    Returns ``(dom, launches, note)``.  ``--virtual-time-budget`` is
    deterministic from the page's point of view, but if the kernel answers one
    RPC after that budget expired the dump is genuinely incomplete; re-dumping
    is the cheap, honest fix, and the longest dump seen is the one reported.
    """
    deadline = time.monotonic() + budget
    launches, last_error, best = 0, "", ""
    while True:
        launches += 1
        raw, error = dump_dom(edge, url, profile, timeout)
        if raw is not None:
            text = dom_of(raw)
            if len(text) > len(best):
                best = text
            if _looks_painted(text):
                return text, launches, ""
            last_error = "the dump never showed both the ready HUD and a painted card"
        else:
            last_error = error
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(1.0, remaining))
    if best:
        return best, launches, last_error
    raise DriverError(f"the browser never produced a DOM within {budget:g}s: {last_error}")


# --------------------------------------------------------------------------
# the live board


def read_board(path: Path) -> dict:
    """Load ``.seide/board.json`` as data; raise :class:`CheckFailed` if unusable.

    Cards are found by walking the raw structure rather than by trusting one
    exact document shape, because the kernel is not the only writer of this
    file: it is user-editable, and ``tools/e2e.py`` writes its own cards too.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CheckFailed(f"cannot read the live board {path}: {exc}") from exc
    try:
        board = json.loads(raw)
    except ValueError as exc:
        raise CheckFailed(f"{path} is not valid JSON: {exc}") from exc
    require(isinstance(board, dict), f"{path} is not a JSON object")
    cards = board.get("cards")
    if not isinstance(cards, list):
        inner = board.get("document")
        cards = inner.get("cards") if isinstance(inner, dict) else None
    require(isinstance(cards, list), f"{path} has no cards array")
    return {"cards": cards, "bytes": len(raw.encode("utf-8"))}


def board_facts(board: dict) -> dict:
    """Pull the two card values this test asserts on out of a loaded board."""
    facts = {"count": len(board["cards"]), "file": None, "note": None, "kinds": []}
    for card in board["cards"]:
        if not isinstance(card, dict):
            continue
        kind = card.get("kind")
        facts["kinds"].append(str(kind))
        if kind == "editor" and facts["file"] is None:
            candidate = card.get("file")
            if isinstance(candidate, str) and candidate.strip():
                facts["file"] = candidate
        if kind == "note" and facts["note"] is None:
            text = card.get("text")
            if isinstance(text, str) and text.strip():
                facts["note"] = text
    return facts


# --------------------------------------------------------------------------
# the checks


class Harness:
    """Runs the named checks against one dumped DOM and records the outcomes."""

    def __init__(self, dom: str, style: Style, stream):
        self.dom = dom
        self.style = style
        self.stream = stream
        self.results = []

    def run(self, name: str, check) -> bool:
        """Execute one check, printing PASS/FAIL with its evidence; never raises."""
        try:
            detail = check() or "ok"
            passed = True
        except (CheckFailed, DriverError) as exc:
            detail, passed = str(exc), False
        except Exception as exc:  # noqa: BLE001 - a test bug is still a failing check
            detail, passed = f"{type(exc).__name__}: {exc}", False
        self.results.append({"name": name, "ok": passed, "detail": detail})
        tag = self.style.ok("PASS") if passed else self.style.bad("FAIL")
        print(f"[{tag}] {name}: {detail}", file=self.stream, flush=True)
        return passed


def define_checks(facts: dict, board_path: Path, dom: str) -> list:
    """The five assertions, as ``(name, callable)`` pairs."""

    def kernel_ready():
        require(
            READY_TEXT in dom,
            f"the DOM does not contain {READY_TEXT!r}; the HUD never reached the ready state "
            f"(status text is {_status_text(dom)!r})",
        )
        return f"found {READY_TEXT!r} in the HUD status span"

    def workspace_reported():
        require(
            STALE_PANEL_TEXT not in dom,
            f"the DOM contains {STALE_PANEL_TEXT!r}: a panel painted before workspace.info "
            "resolved and never repainted",
        )
        lines = workspace_lines(dom)
        require(
            lines,
            f"the DOM reports no workspace root; expected one of "
            f"{' or '.join(repr(item) for item in WORKSPACE_TEXTS)} in the boot log "
            f"(log text is {_short(_plain(dom, 'log'), 160)!r})",
        )
        return f"found {lines[0]!r}, and {STALE_PANEL_TEXT!r} is absent"

    def board_editor_painted():
        source = f"{board_path} first editor card"
        require(facts["file"] is not None, f"{source} has no non-empty 'file' value to assert on")
        needle = facts["file"]
        require(
            needle in dom,
            f"the DOM does not contain the live board's editor path {needle!r} ({source})",
        )
        return f"found {needle!r} ({source})"

    def board_note_painted():
        if facts["note"] is None:
            return "no note card on the board -- nothing to assert (editor card only)"
        prefix = facts["note"][:40]
        source = f"{board_path} first note card"
        if prefix in dom:
            return f"found the first 40 chars of the note text {prefix!r} ({source})"
        # The dump is serialized markup, so text that reaches the page as HTML
        # arrives re-escaped.  A prefix without &, <, > or quotes is compared
        # raw above, which is the strict form; this fallback only accepts the
        # entity spelling for the characters the serializer must escape.
        escaped = html.escape(prefix, quote=True)
        if escaped != prefix and escaped in dom:
            return (
                f"found the HTML-escaped form of the note prefix {escaped!r} ({source}); "
                "the dump escapes markup, so only &, <, > and quotes differ"
            )
        raise CheckFailed(
            f"the DOM contains neither the note prefix {prefix!r} nor its escaped form "
            f"{escaped!r} ({source}).  Note text is a <textarea>.value, which DOM "
            "serialization does not emit, so only the card's 48-char label is visible"
        )

    def command_bar():
        """The command bar is wired up, and what that does and does not prove.

        ``#command-hint`` is filled by a keydown/input listener, and
        ``--dump-dom`` drives no input, so the element is empty in every dump
        and the shipped command rows (``project [glob]``, ``files [glob]``)
        never reach the DOM -- they live in the ``COMMAND_HELP`` array inside
        ``shell/web/cards.mjs``, which the dump cannot see.  What *is* provable
        from a dump is that the bar shipped and that the module defining the
        commands executed: ``main.mjs`` imports ``COMMAND_HELP`` at load time
        and builds the line's key handling around it, so a boot that painted
        the HUD and the board ran that module whole.  Asserting more than this
        would mean asserting a string this tool never received.
        """
        hint = _plain(dom, "command-hint")
        require(
            "command-hint" in dom,
            "the DOM has no #command-hint element: the command bar did not ship",
        )
        require(
            'id="command"' in dom or 'id="command" ' in dom,
            "the DOM has no #command input: the command bar did not ship",
        )
        flat = " ".join(hint.split())
        if "project" in flat and "files" in flat:
            return f"the command-bar hint (#command-hint) lists project and files: {_short(flat, 110)!r}"
        return (
            "the command bar shipped (#command and #command-hint are in the DOM, and the "
            "module that defines the commands ran -- the HUD and board painted); NOT proven: "
            "the hint text, because no keys are typed and --dump-dom drives no input, so "
            "#command-hint is empty and the shipped rows ('project [glob]', 'files [glob]') "
            "stay inside shell/web/cards.mjs's COMMAND_HELP array"
        )

    return [
        ("hud reports kernel ready", kernel_ready),
        ("workspace root reported, no stale panel", workspace_reported),
        ("board painted: editor card file", board_editor_painted),
        ("board painted: note card text", board_note_painted),
        ("command bar lists the shipped commands", command_bar),
    ]


def _element_text(dom: str, element_id: str) -> str:
    """Return the inner markup of ``#element_id`` (non-nested), or ``""``."""
    pattern = re.compile(
        r"<([a-zA-Z][\w:-]*)\b[^>]*\bid=\"%s\"[^>]*>(.*?)</\1>" % re.escape(element_id),
        re.DOTALL,
    )
    match = pattern.search(dom)
    return match.group(2) if match else ""


def _plain(dom: str, element_id: str) -> str:
    """The text content of ``#element_id``, tags stripped."""
    return re.sub(r"<[^>]+>", "", _element_text(dom, element_id))


def _status_text(dom: str) -> str:
    """The HUD status element's text, for a failure message."""
    return _short(_plain(dom, "kernel-status"), 80)


def workspace_lines(dom: str) -> list:
    """Every boot-log line reporting the workspace root, in either separator form.

    Returned rather than a bare boolean so the PASS line can show the string
    that was actually found -- the whole point of reading the live DOM instead
    of trusting the source that was supposed to produce it.
    """
    found = []
    for needle in WORKSPACE_TEXTS:
        if needle in dom and needle not in found:
            found.append(needle)
    return found


# --------------------------------------------------------------------------
# board backup


class BoardBackup:
    """Byte-for-byte snapshot of ``.seide/board.json``, restored in a ``finally``.

    The host rewrites this file on any mutation, so a smoke test that skipped
    this would reorder a developer's board -- and the shipped starter board --
    a little more on every run.
    """

    def __init__(self, path: Path):
        self.path = path
        self.existed = path.is_file()
        self.bytes = path.read_bytes() if self.existed else None
        self.backup = None
        self.installed = False
        self.restored_identical = False

    def install_if_absent(self) -> None:
        """Give a fresh clone something to paint.

        ``.seide/board.json`` is gitignored, so a clone has no board at all and
        the host would paint an empty canvas with nothing to assert on -- which
        is how ``make smoke`` failed on the first fresh clone.  The starter
        board in ``examples/`` is the same document, so install it for the run.

        This is safe because :meth:`restore` already remembers the file was not
        there and takes it away again; the run leaves the tree as it found it.
        """
        if self.existed:
            return
        if not STARTER_BOARD.is_file():
            raise DriverError(
                f"no board at {self.path} and no starter board at {STARTER_BOARD}"
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(STARTER_BOARD.read_bytes())
        self.installed = True

    def snapshot(self) -> None:
        """Copy the original bytes aside, so even a hard kill is recoverable."""
        if not self.existed:
            return
        handle, name = tempfile.mkstemp(prefix="board.json.", suffix=".bak")
        with os.fdopen(handle, "wb") as stream:
            stream.write(self.bytes)
        self.backup = Path(name)

    def restore(self) -> bool:
        """Write the original bytes back; return True when byte-identical."""
        try:
            if not self.existed:
                # Nothing was here before: the run's own board has to go, and a
                # ``.seide/`` this test created must not be left behind either.
                if self.installed and self.path.is_file():
                    self.path.unlink()
                try:
                    if self.path.parent.is_dir() and not any(self.path.parent.iterdir()):
                        self.path.parent.rmdir()
                except OSError:
                    pass
                self.restored_identical = not self.path.exists()
                return self.restored_identical
            if not (self.path.is_file() and self.path.read_bytes() == self.bytes):
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_bytes(self.bytes)
            self.restored_identical = (
                self.path.is_file() and self.path.read_bytes() == self.bytes
            )
        except OSError:
            self.restored_identical = False
        return self.restored_identical

    def discard(self) -> None:
        """Delete the aside copy once the original is back and verified."""
        if self.backup is not None:
            try:
                self.backup.unlink()
            except OSError:
                pass
            self.backup = None


# --------------------------------------------------------------------------
# entry point


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="browser_smoke.py",
        description=(
            "Drive the seIDE board UI in the real browser and assert on the dumped DOM. "
            "Exit codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage."
        ),
    )
    parser.add_argument(
        "--port", type=int, default=0, metavar="N",
        help="port for the host (default: ask the OS for a free one)",
    )
    parser.add_argument(
        "--edge", default=None, metavar="PATH",
        help="browser executable (default: the system Edge, if installed)",
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, metavar="S",
        help="seconds for the host to start and per browser launch (default 60)",
    )
    parser.add_argument(
        "--keep", action="store_true",
        help="keep the throwaway browser profile and the board backup",
    )
    return parser


def _run(host: Host, backup: BoardBackup, edge, args, style: Style) -> int:
    """Start, drive and judge one run; the caller owns every cleanup."""
    profile_dir = None
    exits = 1
    restored = False
    host_gone = False
    got_dom = False
    passed = failed = total = attempts = 0
    try:
        host.start()
        show("serving", f"{host.url} (pid {host.proc.pid})")
        banner = host.wait_ready(args.timeout)
        show("host ready", _short(banner, 300))
        status = host.probe(timeout=min(10.0, args.timeout))
        if status != 200:
            raise DriverError(f"GET / answered {status}, expected 200")
        show("http", f"GET / -> {status}")

        profile_dir = Path(tempfile.mkdtemp(prefix="seide-smoke-edge-"))
        show("profile", str(profile_dir))
        dom, attempts, note = grab_dom(
            edge, host.url, profile_dir, args.timeout, budget=min(args.timeout, 90.0)
        )
        got_dom = True
        show("dom", f"{len(dom)} chars from {attempts} browser launch(es)")
        if note:
            show("dom note", note)
            if attempts > 1:
                # Every launch was cut short; say so rather than letting a
                # best-effort dump look like a clean one.
                show("dom caution", "the dump may be missing late-arriving state")

        board = read_board(BOARD_PATH)
        facts = board_facts(board)
        show(
            "live board",
            f"{facts['count']} cards ({', '.join(facts['kinds']) or 'none'}), "
            f"editor file={facts['file']!r}",
        )
        print(style.dim("-" * 68))

        harness = Harness(dom, style, sys.stdout)
        for name, check in define_checks(facts, BOARD_PATH, dom):
            harness.run(name, check)
        passed = sum(1 for item in harness.results if item["ok"])
        failed = sum(1 for item in harness.results if not item["ok"])
        total = len(harness.results)
        exits = 0 if failed == 0 else 1
    except (DriverError, CheckFailed) as exc:
        show("FAIL", f"{exc}")
        tail = host.tail()
        if tail:
            show("host output", _short(tail, 500))
        exits = 2
    except KeyboardInterrupt:
        show("interrupted", "the run was cancelled from the keyboard")
        exits = 130
    finally:
        host_gone = host.close()
        if profile_dir is not None:
            if args.keep:
                show("profile kept", str(profile_dir))
            elif not got_dom:
                # The run never got a usable DOM, so the debris is the evidence.
                show("profile kept", f"{profile_dir} (the run never produced a DOM)")
            else:
                shutil.rmtree(profile_dir, ignore_errors=True)

    restored = backup.restore()
    print(style.dim("-" * 68))
    if backup.existed:
        exact = "byte-identical" if restored else "NOT byte-identical"
        show("restore", f"{BOARD_PATH} restored ({exact})")
    elif restored:
        show("restore", f"{BOARD_PATH} removed again (the clone had none)")
    else:
        show("restore", f"FAIL {BOARD_PATH} is still there -- remove it by hand")
    if args.keep and backup.backup is not None:
        show("board backup kept", str(backup.backup))
    elif not restored and backup.backup is not None:
        # The bytes on disk are not the ones this run started with, so the aside
        # copy is now the only copy of the original: keep it, always.
        show("board backup kept", f"{backup.backup} (the restore was not byte-identical)")
    else:
        backup.discard()
    show("host", "terminated by pid" if host_gone else "DID NOT EXIT -- kill it by hand")

    if exits == 0 and (not restored or not host_gone):
        # Never exit 0 while the environment is not as it was found.
        exits = 1
        failed += 1
    if exits != 0:
        # A failing run still owes the reader a summary line; the per-check
        # PASS/FAIL lines above are the detail.
        if failed == 0:
            failed = 1  # the environment, not a check, is what failed
        print(
            f"summary: {passed} passed, {style.bad(f'{failed} failed')} "
            f"({total} checks, {attempts} browser launch(es))"
        )
        return exits

    summary = (
        f"summary: {style.ok(f'{passed} passed')}, 0 failed "
        f"({total} checks, {attempts} browser launch(es))"
    )
    print(summary)
    return 0


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    parsed = _build_parser().parse_args(argv)
    stream = sys.stdout
    style = Style(colour_enabled(stream))
    started = time.monotonic()

    if parsed.timeout <= 0:
        _build_parser().error("--timeout must be positive")
    if parsed.port < 0 or parsed.port > 65535:
        print(f"browser_smoke.py: --port {parsed.port} is not a TCP port", file=sys.stderr)
        return 2

    try:
        edge = find_edge(parsed.edge)
    except DriverError as exc:
        show("SKIP", f"no browser available: {exc}")
        show("how to fix", "pass --edge PATH, or install Microsoft Edge")
        print("summary: 0 passed, 0 failed, 5 skipped (no browser)")
        return 0

    show("seIDE browser smoke", str(REPO_ROOT))
    show("browser", str(edge))
    show("kernel", f"{SHELL_MAIN.relative_to(REPO_ROOT)} (node)")

    # Back the board up BEFORE the host can touch it, and choose the port:
    # both can fail, and neither may leave a process or a modified file behind.
    backup = BoardBackup(BOARD_PATH)
    backup.snapshot()
    try:
        backup.install_if_absent()
    except (DriverError, OSError) as exc:
        show("FAIL setup", f"{exc}")
        backup.discard()
        return 2
    show(
        "board",
        str(BOARD_PATH)
        if backup.existed
        else f"{BOARD_PATH} (absent -- installed {STARTER_BOARD.name} for this run)",
    )
    print(style.dim("-" * 68))

    try:
        port = parsed.port or free_port()
    except OSError as exc:
        show("FAIL setup", f"cannot pick a free port: {exc}")
        backup.discard()
        return 2

    host = Host(port)
    try:
        code = _run(host, backup, edge, parsed, style)
    except KeyboardInterrupt:
        code = 130
    except Exception as exc:  # noqa: BLE001 - never leave the host or board behind
        show("FAIL unexpected", f"{type(exc).__name__}: {exc}")
        terminate(host.proc)
        backup.restore()
        backup.discard()
        code = 2

    if code == 0:
        print(style.dim(f"total {time.monotonic() - started:.1f}s"))
    return code


if __name__ == "__main__":
    sys.exit(main())
