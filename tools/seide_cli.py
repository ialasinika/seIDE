"""A second client: drive a workspace over the frozen protocol, from a shell.

The reference client in `shell/web/` is today's only consumer of
`docs/PROTOCOL.md`, and a contract with one consumer is a contract nobody has
tested.  This is the other consumer -- a user-facing tool that speaks the same
newline-delimited JSON-RPC to the kernel, imports nothing from `shell/`, and is
useful on its own:

    python tools/seide_cli.py hello
    python tools/seide_cli.py info
    python tools/seide_cli.py ls "**/*.py" --limit 20
    python tools/seide_cli.py cat README.md --meta
    python tools/seide_cli.py write notes.txt --text "hello\n"
    python tools/seide_cli.py board
    python tools/seide_cli.py run "python tools/bf.py examples/hello.bf"
    python tools/seide_cli.py selfcheck          # this client's own checks

It is also the second *document*: the kernel persists a view document without
looking inside it, so this client names its own path and stores its own shape.
Nothing here needs the kernel to know what a board is.

The transport is `tools/kernel_drive.py`, the same stdlib driver the kernel
probe uses; everything above it -- the commands, the safety rails, the checks --
is this file.  Nothing is guessed: a refusal from the kernel is printed with its
code and name and becomes the exit code, so it composes in a script.

`write` will not silently replace a file.  With no `--base-revision` and no
`--force` it reads first and refuses if the file exists, because the whole point
of `base_revision` is that the caller saw the version it is replacing.

Exit codes:

    0   it worked
    1   the kernel refused the request, or a self-check failed
    2   the command line was wrong
    3   the kernel said nothing, or sent a frame this client cannot read
    124 a `run` did not finish inside --timeout (the run is stopped first)

Reads have a fixed five-second budget (the driver's), so a `ls` over a very large
workspace would show up as `<silence>` rather than as a slow listing.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Error messages and board labels carry whatever the workspace carries: print
# UTF-8 rather than dying on a cp936 console.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from kernel_drive import EXE, Kernel  # noqa: E402  (after the sys.path line)

#: The fields a card is labelled by, in the order the board UI would show them.
LABEL_FIELDS = ("title", "file", "path", "cmd", "query", "filter")

#: Where this client keeps its document.  The kernel used to decide
#: (`SDE_BOARD_RELPATH`); now the client names the path on every call, so this
#: constant is the only place this tool commits to one.
DOCUMENT_PATH = ".seide/board.json"

#: `proc.stop` is asked for after this many seconds without a `proc.exit`.
DEFAULT_RUN_TIMEOUT = 60.0


class Refused(Exception):
    """The kernel answered with an error frame."""

    def __init__(self, frame):
        error = frame.get("error") or {}
        super().__init__(str(error.get("message") or "the kernel refused it"))
        self.code = error.get("code")
        self.name = error.get("name")
        self.data = error.get("data")

    def describe(self) -> str:
        code = self.code if self.code is not None else "?"
        name = self.name or "?"
        line = f"the kernel refused: {code} {name}: {self}"
        if self.data is not None:
            line += f" ({json.dumps(self.data, ensure_ascii=False)})"
        return line


class Broken(Exception):
    """The transport failed: silence, or a frame that is not a reply."""


class Cli:
    """One `seide rpc` process, plus the request/response bookkeeping."""

    def __init__(self, root, exe=str(EXE)):
        self.root = str(Path(root).resolve())
        self.kernel = Kernel(self.root, exe=str(exe))

    def request(self, method, params=None):
        """Send one request; return its result, or raise Refused/Broken."""
        reply = self.kernel.call(method, params)
        if reply == "<silence>":
            raise Broken(f"the kernel said nothing to `{method}`")
        # The driver hands back the parsed reply when it could parse one, and the
        # raw line when it could not.
        if isinstance(reply, dict):
            frame = reply
        else:
            try:
                frame = json.loads(reply)
            except ValueError:
                raise Broken(f"the kernel sent a frame that is not JSON: {str(reply)[:200]}")
            if not isinstance(frame, dict):
                raise Broken(f"the kernel sent a frame that is not an object: {str(reply)[:200]}")
        if "error" in frame:
            raise Refused(frame)
        return frame.get("result")

    def next_frame(self, timeout):
        """The next frame off the wire, parsed, or None when the wait runs out.

        Notifications are the only thing this is for; replies are the job of
        `request`, which knows which id it is waiting for.
        """
        got = self.kernel.next_reply(timeout)
        if got == "<silence>":
            return None
        try:
            frame = json.loads(got)
        except ValueError:
            return {"unreadable": got}
        return frame

    def close(self):
        self.kernel.close()


# --- printing helpers -------------------------------------------------------


def human_size(count) -> str:
    """`812 B`, `4.2 KiB`; anything unknown prints as `?`."""
    try:
        size = float(count)
    except (TypeError, ValueError):
        return "?"
    if size < 1024:
        return f"{int(size)} B"
    for unit in ("KiB", "MiB"):
        size /= 1024.0
        if size < 1024:
            return f"{size:.1f} {unit}"
    return f"{size / 1024.0:.1f} GiB"


def label_of(card) -> str:
    """The one field a human would use to name this card."""
    for field in LABEL_FIELDS:
        value = card.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip().splitlines()[0][:60]
    return ""


def write_out(text) -> None:
    """Write to stdout without letting a console encoding kill the client."""
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        sys.stdout.write(text.encode("utf-8", "replace").decode("ascii", "replace"))


# --- commands ---------------------------------------------------------------


def cmd_hello(cli, args) -> int:
    result = cli.request("hello") or {}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"protocol     {result.get('protocol')} ({result.get('protocol_name')})")
    print(f"kernel       {result.get('kernel_version')}")
    print(f"root         {result.get('root')}")
    print(f"pid          {result.get('pid')}")
    return 0


def cmd_info(cli, args) -> int:
    result = cli.request("workspace.info") or {}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"name         {result.get('name')}")
    print(f"root         {result.get('root')}")
    print(f"files        {result.get('file_count')}")
    # `view_path`/`view_revision` describe what the *kernel* is holding right
    # now, which for a fresh CLI process is nothing.  The path this client will
    # use is its own choice, so print both rather than pretend they agree.
    print(f"document     {DOCUMENT_PATH}")
    print(f"held         {result.get('view_path') or '(nothing loaded yet)'}")
    print(f"revision     {result.get('view_revision')}")
    print(f"ignored      {', '.join(result.get('ignored') or [])}")
    return 0


def cmd_ls(cli, args) -> int:
    params = {}
    if args.glob:
        params["glob"] = args.glob
    if args.limit is not None:
        params["limit"] = args.limit
    result = cli.request("workspace.list", params or None) or {}
    files = result.get("files") or []
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    for item in files:
        path = str(item.get("path", "?"))
        if item.get("dir"):
            print(f"{'':>9}  {path}/")
        else:
            print(f"{human_size(item.get('size')):>9}  {path}")
    count = result.get("count", len(files))
    tail = " (truncated)" if result.get("truncated") else ""
    print(f"{count} entr{'y' if count == 1 else 'ies'}{tail}")
    return 0


def cmd_cat(cli, args) -> int:
    result = cli.request("file.read", {"path": args.path}) or {}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.meta:
        print(
            f"# {result.get('path')} {result.get('size')} bytes"
            f" revision {result.get('revision')} {result.get('eol')}",
            file=sys.stderr,
        )
    write_out(result.get("text") or "")
    return 0


def cmd_write(cli, args) -> int:
    if args.text is not None and args.from_file:
        print("seide_cli: pass --text or --from, not both", file=sys.stderr)
        return 2
    if args.text is None and not args.from_file:
        print("seide_cli: pass --text or --from", file=sys.stderr)
        return 2
    if args.from_file:
        text = io.open(args.from_file, "r", encoding="utf-8", newline="").read()
    else:
        text = args.text
    if args.base_revision is None and not args.force:
        try:
            current = cli.request("file.read", {"path": args.path}) or {}
        except Refused as refused:
            if refused.code != 1002:  # NOT_FOUND: the file is new, which is fine
                raise
        else:
            print(
                f"seide_cli: {args.path} exists (revision {current.get('revision')});"
                " pass --base-revision <that> or --force",
                file=sys.stderr,
            )
            return 1
    params = {"path": args.path, "text": text}
    if args.base_revision is not None:
        params["base_revision"] = args.base_revision
    result = cli.request("file.write", params) or {}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(
        f"wrote {result.get('path')}: {result.get('size')} bytes,"
        f" revision {result.get('revision')}, {result.get('eol')}"
    )
    return 0


def cmd_board(cli, args) -> int:
    """Print the document this client keeps, as this client reads it.

    The kernel hands back whatever was stored, so the shape below is *this*
    tool's convention -- exactly what `shell/web/board.mjs` does with the same
    bytes.  A document that is not the board shape is reported as such instead
    of being guessed at.
    """
    result = cli.request("view.load", {"path": args.path or DOCUMENT_PATH}) or {}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    document = result.get("document")
    print(f"board {result.get('path')} revision {result.get('revision')}")
    if not isinstance(document, dict) or not isinstance(document.get("cards"), list):
        print("  (not a board document: no `cards` array)")
        return 0
    cards = document.get("cards") or []
    links = document.get("links") or []
    print(f"{len(cards)} card{'s' if len(cards) != 1 else ''},"
          f" {len(links)} link{'s' if len(links) != 1 else ''}")
    for card in cards:
        if not isinstance(card, dict):
            print(f"  {card!r}")
            continue
        geometry = f"{card.get('x')},{card.get('y')} {card.get('w')}x{card.get('h')}"
        print(f"  {str(card.get('id')):<10} {str(card.get('kind')):<8}"
              f" {geometry:<22} {label_of(card)}")
    for link in links:
        if isinstance(link, dict):
            print(f"  {link.get('from')} -> {link.get('to')}")
    return 0


def cmd_run(cli, args) -> int:
    command = " ".join(args.cmd)
    params = {"cmd": command}
    if args.cwd:
        params["cwd"] = args.cwd
    result = cli.request("proc.start", params) or {}
    run_id = result.get("run_id")
    print(f"run {run_id}: {command}", file=sys.stderr)
    deadline = time.monotonic() + args.timeout
    code = None
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        frame = cli.next_frame(min(1.0, left))
        if frame is None:
            continue
        if frame.get("unreadable") is not None:
            raise Broken(f"the kernel sent a frame that is not JSON: {frame['unreadable'][:200]}")
        if frame.get("run_id") != run_id:
            continue
        event = frame.get("event")
        if event == "proc.output":
            text = frame.get("data") or ""
            if frame.get("stream") == "stderr":
                sys.stderr.write(text)
            else:
                write_out(text)
        elif event == "proc.exit":
            code = frame.get("code")
            break
    if code is None:
        cli.request("proc.stop", {"run_id": run_id})
        print(f"run {run_id}: still running after {args.timeout:g}s; stopped",
              file=sys.stderr)
        return 124
    if not args.quiet:
        print(f"run {run_id}: exit {code}", file=sys.stderr)
    return int(code) if isinstance(code, int) else 0


# --- selfcheck --------------------------------------------------------------


def cmd_selfcheck(args) -> int:
    """Drive this client against a scratch workspace and check what came back."""
    failures = []

    def check(label, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f": {detail}" if detail else ""))
        if not ok:
            failures.append(label)

    def want(condition, message):
        if not condition:
            raise AssertionError(message)

    def refused(cli, method, params=None):
        """Return the Refused the kernel owes us, or raise."""
        try:
            cli.request(method, params)
        except Refused as denied:
            return denied
        raise AssertionError(f"{method} was accepted; it should have been refused")

    build_dir = REPO_ROOT / "build"
    build_dir.mkdir(exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="cli-check-", dir=str(build_dir)))
    cli = None
    try:
        cli = Cli(scratch, exe=args.seide)

        # 1. hello, without anything else happening first.
        result = {}
        try:
            result = cli.request("hello") or {}
            # The number and the name have to agree with each other and with the
            # header this binary was built from: a client that trusts one of them
            # reads a stale contract when the other moves.
            number = result.get("protocol")
            header = (REPO_ROOT / "core" / "include" / "seide_cfg.h").read_text(
                encoding="utf-8")
            declared = re.search(r"#define\s+SDE_PROTOCOL_VERSION\s+(\d+)", header)
            ok = (isinstance(number, int) and declared is not None
                  and number == int(declared.group(1))
                  and result.get("protocol_name") == f"seide/{number}"
                  and bool(result.get("kernel_version")))
            check("hello names the protocol and the kernel", ok,
                  f"protocol={number} name={result.get('protocol_name')}"
                  f" version={result.get('kernel_version')}")
        except Exception as exc:
            check("hello names the protocol and the kernel", False, str(exc))

        # 2. a write, with a non-ASCII character, read back exactly.
        try:
            text = "from the second client\n\u00e9\u4e2d\n"
            wrote = cli.request("file.write", {"path": "cli.txt", "text": text}) or {}
            back = cli.request("file.read", {"path": "cli.txt"}) or {}
            ok = back.get("text") == text and back.get("revision") == wrote.get("revision")
            check("a file the CLI writes reads back exactly", ok,
                  f"wrote={wrote.get('size')} read={back.get('size')} eol={back.get('eol')}")
        except Exception as exc:
            check("a file the CLI writes reads back exactly", False, str(exc))

        # 3. the stale revision rail, and the file must not have moved.
        try:
            before = cli.request("file.read", {"path": "cli.txt"}) or {}
            revision = before.get("revision")
            denied = refused(cli, "file.write",
                             {"path": "cli.txt", "text": "gone\n",
                              "base_revision": int(revision) - 1})
            after = cli.request("file.read", {"path": "cli.txt"}) or {}
            ok = (denied.code == 1001
                  and (denied.data or {}).get("current_revision") == revision
                  and after.get("text") == before.get("text"))
            check("a stale revision is refused and the file does not move", ok,
                  f"code={denied.code} name={denied.name}")
        except Exception as exc:
            check("a stale revision is refused and the file does not move", False, str(exc))

        # 4. the listing sees it.
        try:
            listing = cli.request("workspace.list", {"glob": "**/*.txt"}) or {}
            paths = [item.get("path") for item in listing.get("files") or []]
            ok = "cli.txt" in paths
            check("the listing sees what the CLI wrote", ok, f"files={paths}")
        except Exception as exc:
            check("the listing sees what the CLI wrote", False, str(exc))

        # 5. the document: the kernel keeps bytes it cannot read, and still
        #    refuses a write whose base revision has moved on.
        try:
            odd = {"app": "seide_cli", "cards": "not an array", "n": [1, {"x": None}]}
            saved = cli.request("view.save",
                                {"path": DOCUMENT_PATH, "document": odd}) or {}
            loaded = cli.request("view.load", {"path": DOCUMENT_PATH}) or {}
            # The rail compares against what the kernel last read or wrote, so
            # the absent-path read comes last: it would leave the kernel holding
            # nothing, and then even a correct base revision would look stale.
            stale = refused(cli, "view.save",
                            {"path": DOCUMENT_PATH, "document": odd,
                             "base_revision": int(saved.get("revision") or 0) - 1})
            null = refused(cli, "view.save",
                           {"path": DOCUMENT_PATH, "document": None})
            absent = cli.request("view.load",
                                 {"path": ".seide/never-written.json"}) or {}
            ok = (saved.get("saved") is True
                  and loaded.get("document") == odd
                  and absent.get("document") is None
                  and not absent.get("revision")
                  and stale.name == "STALE_REVISION"
                  and (stale.data or {}).get("current_revision") == saved.get("revision")
                  and null.code == -32602)
            check("the kernel keeps a document it cannot read, and refuses a stale write",
                  ok, f"round_trip={loaded.get('document') == odd}"
                      f" saved={saved.get('saved')!r}"
                      f" absent={absent.get('document')!r}/{absent.get('revision')!r}"
                      f" stale={stale.name}"
                      f" current={(stale.data or {}).get('current_revision')!r}"
                      f"/{saved.get('revision')!r} null_document={null.code}")
        except Exception as exc:
            check("the kernel keeps a document it cannot read, and refuses a stale write",
                  False, str(exc))

        # 6. a real child, both directions: what this client writes reaches the
        #    child's stdin, what the child writes arrives as notifications, and
        #    closing the input is how the child learns there is no more.
        try:
            child = scratch / "child.py"
            io.open(child, "w", encoding="utf-8", newline="\n").write(
                "import sys\n"
                "data = sys.stdin.read()\n"
                "print('from-the-child:' + data.strip())\n"
                "sys.exit(3)\n")
            started = cli.request("proc.start",
                                 {"cmd": f'"{sys.executable}" "{child}"'}) or {}
            run_id = started.get("run_id")
            written = cli.request("proc.send", {"run_id": run_id, "data": "ping\n"}) or {}
            listed = cli.request("proc.list") or {}
            runs = listed.get("runs") if isinstance(listed.get("runs"), list) else []
            seen = [run for run in runs if run.get("run_id") == run_id]
            closed = cli.request("proc.close", {"run_id": run_id}) or {}
            after_close = refused(cli, "proc.send", {"run_id": run_id, "data": "again\n"})
            stdout_parts = []
            code = None
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline and code is None:
                frame = cli.next_frame(1.0)
                if frame is None or frame.get("run_id") != run_id:
                    continue
                if frame.get("event") == "proc.output":
                    stdout_parts.append(frame.get("data") or "")
                elif frame.get("event") == "proc.exit":
                    code = frame.get("code")
            text = "".join(stdout_parts)
            ok = (written.get("written") == 5 and closed.get("closed") is True
                  and len(seen) == 1 and after_close.code == 1005
                  and code == 3 and "from-the-child:ping" in text)
            check("a run's input, output and exit code all cross the channel", ok,
                  f"written={written.get('written')} listed={len(seen)} "
                  f"closed={closed.get('closed')} after_close={after_close.code} "
                  f"code={code} stdout={text.strip()!r}")
        except Exception as exc:
            check("a run's input, output and exit code all cross the channel", False, str(exc))

        # 7. the boundary: `lang.*` is the shell's, not the kernel's, and this
        #    client talks to the kernel.
        try:
            denied = refused(cli, "lang.list")
            ok = denied.code == -32601
            check("the kernel answers for itself: a shell-only method is METHOD_NOT_FOUND",
                  ok, f"code={denied.code} name={denied.name}")
        except Exception as exc:
            check("the kernel answers for itself: a shell-only method is METHOD_NOT_FOUND",
                  False, str(exc))

        # 8. the command line as a user meets it: `write` must not replace a file
        #    it was not shown the revision of.
        try:
            def run_cli(*argv):
                return subprocess.run(
                    [sys.executable, str(HERE / "seide_cli.py"),
                     "--root", str(scratch), "--seide", str(args.seide)] + list(argv),
                    capture_output=True, text=True, encoding="utf-8", errors="replace")

            first = run_cli("write", "cli2.txt", "--text", "one\n")
            second = run_cli("write", "cli2.txt", "--text", "two\n")
            forced = run_cli("write", "cli2.txt", "--text", "two\n", "--force")
            ok = (first.returncode == 0
                  and second.returncode == 1
                  and "--base-revision" in (second.stderr or "")
                  and forced.returncode == 0)
            check("write refuses to replace a file with no base revision (and --force says so)",
                  ok, f"exit={first.returncode}/{second.returncode}/{forced.returncode}")
        except Exception as exc:
            check("write refuses to replace a file with no base revision (and --force says so)",
                  False, str(exc))
    finally:
        if cli is not None:
            cli.close()
        shutil.rmtree(scratch, ignore_errors=True)

    if failures:
        print(f"summary: {len(failures)} FAILED -> " + "; ".join(failures))
        return 1
    print("summary: all ok")
    return 0


# --- the command line -------------------------------------------------------


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"seide_cli.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="seide_cli.py",
        description="A second client for the seIDE kernel protocol: read, write, "
                    "list, run and inspect a document without opening the window.",
    )
    parser.add_argument("--root", default=".", metavar="DIR",
                        help="the workspace to point the kernel at (default: .)")
    parser.add_argument("--seide", default=str(EXE), metavar="EXE",
                        help="the kernel binary (default: build/seide.exe)")
    subs = parser.add_subparsers(dest="command", metavar="COMMAND")

    def add(name, help_text, func):
        sub = subs.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("--json", action="store_true", help="print the raw result")
        sub.set_defaults(func=func)
        return sub

    add("hello", "ask the kernel who it is", cmd_hello)
    add("info", "the workspace: root, name, file count, this client's document", cmd_info)

    ls = add("ls", "list the workspace", cmd_ls)
    ls.add_argument("glob", nargs="?", metavar="GLOB", help="the glob to list")
    ls.add_argument("--limit", type=int, metavar="N", help="at most N entries")

    cat = add("cat", "print a file", cmd_cat)
    cat.add_argument("path", metavar="PATH")
    cat.add_argument("--meta", action="store_true",
                     help="describe the file on stderr, so stdout stays pipeable")

    write = add("write", "write a whole file", cmd_write)
    write.add_argument("path", metavar="PATH")
    write.add_argument("--text", metavar="TEXT", help="the new contents")
    write.add_argument("--from", dest="from_file", metavar="FILE",
                       help="read the new contents from this file")
    write.add_argument("--base-revision", type=int, metavar="R",
                       help="the revision you last read (the stale check)")
    write.add_argument("--force", action="store_true",
                       help="replace an existing file with no base revision")

    # The kernel stores a document without reading it, so the *client* owns the
    # path and the schema.  `board` is how this client draws the one it keeps.
    board = add("board", "print the document this client keeps: cards, links, revision",
                cmd_board)
    board.add_argument("--path", metavar="PATH",
                       help=f"the document to read (default: {DOCUMENT_PATH})")

    run = add("run", "start a child and stream what it says", cmd_run)
    run.add_argument("cmd", nargs="+", metavar="CMD",
                     help="the command line, quoted as one argument if it has spaces")
    run.add_argument("--cwd", metavar="DIR", help="the child's working directory")
    run.add_argument("--timeout", type=float, default=DEFAULT_RUN_TIMEOUT, metavar="SECONDS",
                     help=f"stop the child after this long (default {DEFAULT_RUN_TIMEOUT:g})")
    run.add_argument("--quiet", action="store_true", help="no run/exit banner on stderr")

    subs.add_parser("selfcheck", help="check this client against a scratch workspace")
    subs.choices["selfcheck"].set_defaults(func=None)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 2
    if args.command == "selfcheck":
        return cmd_selfcheck(args)
    try:
        cli = Cli(args.root, exe=args.seide)
    except OSError as exc:
        print(f"seide_cli: cannot start {args.seide}: {exc}", file=sys.stderr)
        return 3
    try:
        return args.func(cli, args)
    except Refused as denied:
        print(denied.describe(), file=sys.stderr)
        return 1
    except Broken as broken:
        print(f"seide_cli: {broken}", file=sys.stderr)
        return 3
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
