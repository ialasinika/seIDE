#!/usr/bin/env python3
"""release.py -- cut a seIDE release, from the branch check to the tag.

    python tools/release.py --dry-run          # the whole plan; writes nothing
    python tools/release.py                    # cut the channel VERSION names
    python tools/release.py --channel beta
    python tools/release.py --fork electron-example
    python tools/release.py --no-tag --skip-tests

A release is a claim, so this script is the claim's receipt.  It refuses to
produce artifacts from a tree it cannot describe: the version must parse and
agree with every copy of itself, the branch must be the one this channel
releases from, the tree must be clean, the tag must be free, `make test` must
pass, and the changelog must be able to name the version.  Only then does it
write anything.

What each channel ships (docs/RELEASING.md is the prose version):

    alpha              the source archive
    beta / rc / final  the source archive and the runnable win64 bundle
    1.x final / lts    the same, plus the MSI and a bundle per named fork
    any channel        source is always included: a binary nobody can rebuild
                       is not a seIDE release.

Every release directory gets `SHA256SUMS`, `RELEASE-NOTES.md` and
`manifest.json`.  The manifest is the machine-readable twin of the notes --
version, channel, commit, toolchain, every artifact with its hash, and every
check that actually ran -- so a fork or a mirror can assert what it has.

Exit codes
    0   the release was cut (or --dry-run planned it)
    1   a gate failed: dirty tree, wrong branch, tag taken, a suite failed
    2   a tool or a file this needs is missing
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO_ROOT = TOOLS.parent
# The two tools this one builds on, imported on purpose: build.py knows where
# the toolchain is on a machine that has it but not on PATH, and version.py
# owns the one version number.  Neither is reimplemented here.
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import build as build_tool  # noqa: E402
import version as version_tool  # noqa: E402

# A release log must not die on its last line because the console is cp936:
# `make test` prints lines like "ok   U+1F600 -> F0 9F 98 80", and printing one
# of those raised UnicodeEncodeError after the tag had already been made.  Print
# UTF-8 where the stream allows it, replacement characters where it does not.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

CHANGELOG = REPO_ROOT / "CHANGELOG.md"
FORKS_DIR = REPO_ROOT / "forks"
MSI_BUILD = TOOLS / "msi" / "build.py"
DIST_ROOT = REPO_ROOT / "dist"
GIT = shutil.which("git") or "git"

#: The bundle is the repository, minus what only a developer needs, plus the
#: compiled kernel.  The shell finds `build/seide.exe` and `langs/` by looking
#: next to itself (shell/main.mjs), so the bundle keeps the tree's shape.
BUNDLE_FILES = ("VERSION", "README.md", "CHANGELOG.md", "LICENSE", "LICENSE-DOCS")
BUNDLE_TREES = ("shell", "langs", "docs", "examples")
BUNDLE_KERNEL = "build/seide.exe"

#: What a channel may ship, and the branch it is cut from.  `{major}` and
#: `{minor}` are filled from the version.
CHANNELS = {
    "alpha": {"branch": "main", "artifacts": ("src",), "tests": ("test",)},
    "beta": {"branch": "release/{major}.{minor}", "artifacts": ("src", "bundle"), "tests": ("test", "smoke")},
    "rc": {"branch": "release/{major}.{minor}", "artifacts": ("src", "bundle"), "tests": ("test", "smoke")},
    "final": {"branch": "release/{major}.{minor}", "artifacts": ("src", "bundle"), "tests": ("test", "smoke")},
    "lts": {"branch": "lts/{major}.{minor}", "artifacts": ("src", "bundle"), "tests": ("test", "smoke")},
}
CHANNEL_NAMES = ("alpha", "beta", "rc", "final", "lts")
#: LTS and the MSI are 1.x ideas: the 0.x line is the pre-interface line, and
#: docs/RELEASING.md says so.
LTS_MIN_MAJOR = 1
MSI_MIN_MAJOR = 1
#: A tag is never a second-class citizen: for a fork it is `<fork>-v<version>`.
TAG_PREFIX = "v"


class ReleaseError(Exception):
    """A gate said no.  ``code`` is the process exit code to use."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"release.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


# ---------------------------------------------------------------------------
# talking to the machine
# ---------------------------------------------------------------------------


def run(command, cwd=REPO_ROOT, capture: bool = True, timeout=None, env=None):
    """Run a command, echoing it.  Returns ``(exit code, output)``.

    The captured bytes are decoded as UTF-8 with replacement characters, and
    the child's Python is told to write UTF-8.  This machine's locale is cp936,
    so a suite that prints an em dash used to make ``text=True`` raise inside
    the read -- and the release notes recorded ``exit 0: (no output)`` for a run
    that had printed thirteen kilobytes of evidence.  A release note that says
    nothing is worse than one that says the truth badly.
    """
    shown = " ".join(str(part) for part in command)
    print(f"==> {shown}  (cwd={cwd})", flush=True)
    child_env = dict(os.environ if env is None else env)
    child_env.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        if capture:
            done = subprocess.run(
                [str(part) for part in command],
                cwd=str(cwd),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                env=child_env,
                check=False,
            )
            output = (done.stdout or "") + (done.stderr or "")
            return done.returncode, output
        return subprocess.call([str(part) for part in command], cwd=str(cwd), env=child_env), ""
    except OSError as exc:
        raise ReleaseError(f"cannot run {shown}: {exc}", 2)
    except subprocess.TimeoutExpired:
        raise ReleaseError(f"{shown} did not finish in {timeout}s", 2)


def git(*args, capture: bool = True, env=None):
    """Run git in the repository root."""
    return run([GIT, *args], capture=capture, env=env)


def git_text(*args) -> str:
    """Run git and return its stdout, failing the release if it fails."""
    code, output = git(*args)
    if code != 0:
        raise ReleaseError(f"git {' '.join(str(a) for a in args)} failed: {output.strip()}")
    return output


#: A line that reports a result, rather than a step of one.  `make test` ends
#: with a coverage note, which says what was *not* covered, not what passed.
RESULT_LINE = re.compile(
    r"(\d+\s+(passed|failed|skipped)\b"
    r"|\b\d+/\d+\s+checks?\b"
    r"|\bok\s+\d+/\d+\b"
    r"|\ball ok\b|\ball good\b|\bsummary:)"
)


def result_summary(output: str, limit: int = 6) -> str:
    """The lines of a captured command that report a result, joined.

    One line would misdescribe `make test`, which runs six suites and then
    prints a note; six result lines are what a release note should carry.
    """
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return "(no output)"
    results = [line for line in lines if RESULT_LINE.search(line)]
    if not results:
        return lines[-1]
    return "; ".join(results[-limit:])


def tool_versions() -> dict:
    """What built this release, so a manifest can be checked against it later."""
    found = {
        "git": GIT,
        "make": build_tool.find_tool(build_tool.MAKE_NAMES, "MAKE"),
        "gcc": build_tool.find_tool(build_tool.GCC_NAMES, "GCC"),
        "python": sys.version.split()[0],
        "node": shutil.which("node") or "",
    }
    for name in ("git", "make", "gcc", "node"):
        tool = found.get(name)
        if tool:
            # `which()` hands back a str and `find_tool()` a Path; a manifest
            # that reports a toolchain must not have blank rows because of that.
            found[name + "_version"] = build_tool.version_line(Path(str(tool)))
    return {key: (str(value) if value else "") for key, value in found.items()}


def sha256_of(data: bytes) -> str:
    """The hex digest of some bytes."""
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    """The hex digest of a file, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# the repository, as the release sees it
# ---------------------------------------------------------------------------


def version_now() -> dict:
    """The version in ``VERSION``, parsed."""
    raw = version_tool.read_version_file()
    info = version_tool.parse(raw)
    if info is None:
        raise ReleaseError(f"VERSION holds {raw!r}, which is not SemVer 2.0.0", 2)
    return info


def resolve_channel(info: dict, requested: str) -> str:
    """Pick the channel, and refuse a --channel that disagrees with VERSION."""
    inferred = info["channel"] or "final"
    if requested and requested != inferred:
        raise ReleaseError(
            f"--channel {requested} disagrees with VERSION {info['version']} "
            f"(which is a {inferred} version); change VERSION first (tools/version.py set)"
        )
    channel = requested or inferred
    if channel == "lts" and info["major"] < LTS_MIN_MAJOR:
        raise ReleaseError(
            f"{info['version']} cannot be LTS: LTS starts at {LTS_MIN_MAJOR}.0.0 "
            "(docs/RELEASING.md); the 0.x line only publishes alpha/beta/rc/final builds"
        )
    return channel


def expected_branch(channel: str, info: dict) -> str:
    """The branch this channel is cut from."""
    return CHANNELS[channel]["branch"].format(major=info["major"], minor=info["minor"])


def tag_name(fork: str, version: str) -> str:
    """The annotated tag for this release."""
    return f"{fork}-{TAG_PREFIX}{version}" if fork else f"{TAG_PREFIX}{version}"


def commit_info(rev: str) -> dict:
    """Commit, date and subject, as the manifest and the notes want them."""
    text = git_text("log", "-1", "--format=%H%n%cd%n%s", "--date=format:%Y-%m-%dT%H:%M:%S%z", rev)
    lines = text.strip().splitlines()
    if len(lines) < 3:
        raise ReleaseError(f"cannot describe {rev}")
    return {"commit": lines[0].strip(), "date": lines[1].strip(), "subject": lines[2].strip()}


def tracked(prefixes) -> list:
    """Tracked paths under the given prefixes, in git's order."""
    text = git_text("ls-files", "--", *prefixes)
    return [line.strip().replace("\\", "/") for line in text.splitlines() if line.strip()]


def is_clean() -> bool:
    """True when nothing tracked has uncommitted changes."""
    return not git_text("status", "--porcelain").strip()


def remote_names() -> list:
    """The configured remotes, if any."""
    text = git_text("remote")
    return [line.strip() for line in text.splitlines() if line.strip()]


def read_text(path: Path) -> str:
    """Read a UTF-8 file, preserving its line endings."""
    return version_tool.read_text(path)


def write_text(path: Path, text: str) -> None:
    """Write a UTF-8 file with LF endings."""
    version_tool.write_text(path, text)


# ---------------------------------------------------------------------------
# the changelog
# ---------------------------------------------------------------------------


def changelog_top() -> str:
    """The title of the top ``##`` section, without the ``##``."""
    match = re.search(r"^##\s+(?P<title>.+?)\s*$", read_text(CHANGELOG), re.M)
    return match.group("title") if match else ""


def changelog_body(version: str) -> str:
    """The text of the ``## v<version>`` section, up to the next ``##``.

    The heading carries a date in the house style (``## v0.1.0-alpha -- date``),
    so only the first word has to match.
    """
    text = read_text(CHANGELOG)
    pattern = re.compile(
        r"^##\s+v" + re.escape(version) + r"\b[^\n]*$(?P<body>.*?)(?=^##\s|\Z)", re.M | re.S
    )
    match = pattern.search(text)
    return match.group("body").strip("\n") if match else ""


def freeze_changelog(version: str, day: str) -> bool:
    """Turn the top ``## Unreleased`` into ``## v<version> - <day>``.

    A tag should point at a tree that can name itself, so the release commit is
    the one that dates the changelog.  Returns False when there was nothing to
    freeze (the section already names this version).
    """
    text = read_text(CHANGELOG)
    top = changelog_top()
    first = top.split()[0] if top.split() else ""
    if first == f"v{version}":
        print(f"[keep ] CHANGELOG.md already says '## {top}'")
        return False
    if top != "Unreleased":
        raise ReleaseError(
            f"CHANGELOG.md's top section is '## {top or '(none)'}'; expected '## Unreleased' "
            f"or '## v{version}' (tools/version.py check says the same thing)"
        )
    # The house style separates the version from the date with an em dash.
    frozen = re.sub(r"^##\s+Unreleased\s*$", f"## v{version} \u2014 {day}", text, count=1, flags=re.M)
    if frozen == text:
        raise ReleaseError("CHANGELOG.md has no '## Unreleased' line to freeze")
    write_text(CHANGELOG, frozen)
    print(f"[write] CHANGELOG.md: '## Unreleased' -> '## v{version} \u2014 {day}'")
    return True


# ---------------------------------------------------------------------------
# artifacts
# ---------------------------------------------------------------------------


def zip_items_from_disk(items, root: Path):
    """Turn ``(arcname, relative path, mode)`` into ``(arcname, bytes, mode)``."""
    out = []
    for arcname, relative, mode in items:
        path = root / relative
        if not path.is_file():
            raise ReleaseError(f"missing artifact input: {path}", 2)
        out.append((arcname, path.read_bytes(), mode))
    return out


def write_zip(dest: Path, items) -> dict:
    """Write a deterministic zip: sorted names, fixed mtimes, fixed modes.

    The same commit on the same machine produces the same bytes, which is what
    makes SHA256SUMS worth publishing.
    """
    when = (1980, 1, 1, 0, 0, 0)
    stamp = os.environ.get("SEIDE_ZIP_EPOCH")
    if stamp:
        parsed = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S")
        when = (parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as archive:
        for arcname, data, mode in sorted(items, key=lambda item: item[0]):
            entry = zipfile.ZipInfo(arcname, date_time=when)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3  # unix, so the mode below is meaningful
            entry.external_attr = (mode & 0xFFFF) << 16
            archive.writestr(entry, data)
    return {"name": dest.name, "bytes": dest.stat().st_size, "sha256": file_sha256(dest)}


def source_archive(stem: str, version: str, rev: str, dest: Path) -> dict:
    """The tagged tree itself, straight out of git (so it is exactly the tag).

    ``git archive`` stamps every zip entry with the commit time in the
    archiving machine's local timezone, so the same commit produced two
    different zips when the local cut (+0800) and the CI rebuild (UTC) were
    compared: every entry's CRC matched but its timestamp did not.  Pin the
    child's ``TZ`` to UTC so the bytes depend on the commit, not the machine.
    (v0.4.2-alpha.1 was published before this pin; its tag annotation records
    the +0800 cut and the GitHub asset the UTC rebuild, two hashes over the
    same 131 entries.  See docs/RELEASING.md.)
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    archive_env = dict(os.environ)
    archive_env["TZ"] = "UTC0"
    code, output = git(
        "archive", "--format=zip", f"--prefix={stem}-{version}/", "-o", str(dest), rev, env=archive_env
    )
    if code != 0:
        raise ReleaseError(f"git archive failed: {output.strip()}")
    return {"name": dest.name, "bytes": dest.stat().st_size, "sha256": file_sha256(dest)}


def start_here(version: str, channel: str, info: dict, no_msi: bool = False) -> str:
    """The three lines a bundle needs to be usable by someone who just unzipped it."""
    stage = (
        f"this is a {channel} build: the interface may still change"
        if info["channel"]
        else "this is a final build"
    )
    if channel in ("final", "lts") and info["major"] >= MSI_MIN_MAJOR:
        # A 1.x GA is supposed to come with an installer; say when it does not,
        # in the bundle itself and not only in the notes beside it.
        installer = (
            "  This bundle has no installer: it was cut with `--no-msi`, so the\n"
            "MSI a 1.x release promises is missing on purpose.\n"
            if no_msi
            else "  No service, no registry: the MSI is the installer.\n"
        )
    else:
        installer = "  No installer, no service, no registry.\n"
    return (
        f"seIDE {version} -- win64 bundle ({channel}; {stage})\n"
        "\n"
        "What is in here: the kernel (build/seide.exe), the shell (shell/), the\n"
        "language descriptors (langs/), the docs (docs/), the example board and\n"
        "files (examples/).\n"
        f"{installer}"
        "\n"
        "What is NOT in here: the C sources.  They ship in the matching source\n"
        f"archive (seide-{version}-src.zip); this bundle is the built article.\n"
        "\n"
        "Needs: Node.js 24 or newer for the shell.  Nothing else -- the kernel is\n"
        "a single .exe with no runtime of its own.\n"
        "\n"
        "Run the shell (a browser window, no Electron):\n"
        "    node shell\\main.mjs serve --workspace %USERPROFILE%\\seide-workspace\n"
        "\n"
        "Run the kernel on its own:\n"
        "    build\\seide.exe version\n"
        "    build\\seide.exe --help\n"
        "\n"
        "Read next: README.md (what this is), docs/PARADIGM.md (why it is like\n"
        "this), CHANGELOG.md (what changed).  Licence: LICENSE is the code (MIT),\n"
        "LICENSE-DOCS is the documentation (CC BY 4.0).\n"
    )


def fork_manifest(name: str) -> dict:
    """Read ``forks/<name>/fork.json`` and refuse a fork that is not one."""
    path = FORKS_DIR / name / "fork.json"
    if not path.is_file():
        raise ReleaseError(f"no fork manifest at {path} (see docs/RELEASING.md)", 2)
    try:
        data = json.loads(read_text(path))
    except (ValueError, OSError) as exc:
        raise ReleaseError(f"{path} is not readable JSON: {exc}", 2)
    for key in ("name", "title", "summary"):
        if not data.get(key):
            raise ReleaseError(f"{path} has no {key!r}")
    if data["name"] != name:
        raise ReleaseError(f"{path} says name={data['name']!r}; the directory says {name!r}")
    return data


def fork_overlay_items(name: str):
    """The fork's own files, laid over the bundle root."""
    prefix = f"forks/{name}/files"
    items = []
    for relative in tracked([prefix]):
        arcname = relative[len(prefix) + 1 :]
        if arcname:
            items.append((arcname, relative, 0o644))
    return items


def bundle_items(version: str, channel: str, info: dict, fork: str, no_msi: bool = False):
    """The runnable bundle, as ``(arcname, bytes, mode)`` entries.

    Deterministic on purpose: sorted names, one fixed mtime, explicit modes, so
    the same commit produces the same zip and SHA256SUMS means something.
    """
    items = [("START-HERE.txt", start_here(version, channel, info, no_msi).encode("utf-8"), 0o644)]
    items += zip_items_from_disk([(rel, rel, 0o644) for rel in BUNDLE_FILES], REPO_ROOT)
    items += zip_items_from_disk([(rel, rel, 0o644) for rel in tracked(BUNDLE_TREES)], REPO_ROOT)
    items.append((BUNDLE_KERNEL, (REPO_ROOT / BUNDLE_KERNEL).read_bytes(), 0o755))
    if fork:
        overlay = fork_overlay_items(fork)
        if not overlay:
            raise ReleaseError(f"fork {fork!r} has no files under forks/{fork}/files/ to lay over the bundle")
        items += zip_items_from_disk(overlay, REPO_ROOT)
    return items


def write_staging(items, root: Path) -> Path:
    """Lay a bundle out as real files, which is what a package step installs."""
    if root.exists():
        shutil.rmtree(root)
    for arcname, data, mode in items:
        path = root / arcname
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    return root


def build_fork_zip(version: str, fork: str, fork_data: dict, base: dict, dest: Path) -> dict:
    """A fork's whole delta, plus the instructions to lay it on the base tree.

    The archive keeps the ``forks/<name>/`` prefix: APPLY.md tells the reader to
    copy it over the base tree, and the base tree keeps its forks in a
    directory, so unpacking it there has to land in the same place.
    """
    prefix = f"forks/{fork}"
    items = zip_items_from_disk(
        [(relative, relative, 0o644) for relative in tracked([prefix])], REPO_ROOT
    )
    apply_text = (
        f"{fork_data['title']} -- a seIDE fork ({fork_data.get('kind', 'source overlay')})\n"
        "\n"
        f"Base: seIDE {version}, commit {base['commit']} ({base['date']}).\n"
        f"This release: {tag_name(fork, version)}.\n"
        "\n"
        "What this is: everything the fork changes, and nothing else.  It holds\n"
        f"the same {prefix}/ directory the base tree does.  The base tree is\n"
        f"seide-{version}-src.zip (or `git archive` of the tag\n"
        f"{tag_name('', version)}); unpack this archive over it, then read\n"
        "docs/FORK.md for what a fork is allowed to touch and what it is not.\n"
        "\n"
        "The fork's files in the runnable bundle are laid over the bundle root,\n"
        "so a fork can replace shell/web/cards.mjs, add its own module, or add a\n"
        "dependency of its own without the base tree growing one.  Electron and\n"
        "friends belong here, in a fork, never in the kernel or the base shell.\n"
        "\n"
        f"{fork_data['summary']}\n"
    )
    items.append(("APPLY.md", apply_text.encode("utf-8"), 0o644))
    return write_zip(dest, items)


def build_msi(version: str, bundle: Path, out: Path) -> dict:
    """Run the MSI scaffolding, or say plainly why there is no MSI.

    WiX is not a dependency of this project and is not installed everywhere, so
    the honest outcomes are "here is the MSI" and "here is why there is none".
    A 1.x final or LTS release requires the first; anything else may fall back
    to the second and say so in its notes.
    """
    if not MSI_BUILD.is_file():
        raise ReleaseError(f"no MSI scaffolding at {MSI_BUILD}", 2)
    command = [sys.executable, str(MSI_BUILD), "--bundle", str(bundle), "--version", version, "--out", str(out)]
    code, output = run(command)
    print(output.rstrip())
    if code != 0:
        raise ReleaseError(f"the MSI step failed (exit {code}); see the output above", code or 1)
    if not out.is_file():
        raise ReleaseError(f"the MSI step reported success but wrote no {out}")
    return {"name": out.name, "bytes": out.stat().st_size, "sha256": file_sha256(out)}


# ---------------------------------------------------------------------------
# what the release wrote, and what it promises
# ---------------------------------------------------------------------------


def sha256sums(artifacts) -> str:
    """The usual ``sha256  name`` lines, sorted by name."""
    lines = [f"{item['sha256']}  {item['name']}" for item in sorted(artifacts, key=lambda i: i["name"])]
    return "\n".join(lines) + "\n"


def release_notes(context: dict) -> str:
    """The prose half of the release: what it is, what was checked, what it is not."""
    info, channel = context["info"], context["channel"]
    version, fork = info["version"], context["fork"]
    lines = []
    title = f"seIDE {version}" + (f" (fork {fork})" if fork else "")
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"- channel: {channel}" + (" (the source archive only)" if channel == "alpha" else ""))
    lines.append(f"- commit: {context['base']['commit']} ({context['base']['date']})")
    tag_line = f"- tag: {context['tag']}"
    if not context["tagged"]:
        if context.get("tag_existed"):
            tag_line += " (this run did not create it: --no-tag; the tag already exists)"
        else:
            tag_line += " (NOT created: --no-tag)"
    lines.append(tag_line)
    lines.append(f"- branch: {context['branch']}")
    if fork:
        data = context["fork_data"]
        lines.append(f"- fork: {data['title']} -- {data['summary']}")
    lines.append("")

    lines.append("## What is in this release")
    lines.append("")
    if channel == "alpha":
        lines.append(
            "The source archive, and nothing else: per docs/RELEASING.md an alpha is a "
            "source-only release.  There is no binary bundle until beta."
        )
    else:
        lines.append(
            "The source archive (rebuild it and you get the same thing) and the runnable "
            "win64 bundle."
        )
    if channel in ("final", "lts") and info["major"] >= MSI_MIN_MAJOR:
        if context["no_msi"]:
            lines.append(
                "No MSI installer: `--no-msi` was given, so this release is not what a 1.x GA "
                "promises.  Everything else a GA release has is here."
            )
        else:
            lines.append("The MSI installer.")
    if fork:
        lines.append(
            f"The bundle of the fork named on this release (`{fork}`) and the delta that "
            "builds it."
        )
    lines.append("")
    lines.append("| artifact | bytes | sha256 |")
    lines.append("| --- | ---: | --- |")
    for item in sorted(context["artifacts"], key=lambda i: i["name"]):
        lines.append(f"| {item['name']} | {item['bytes']} | `{item['sha256']}` |")
    lines.append("")

    lines.append("## What was checked")
    lines.append("")
    if context["tests"]:
        for test in context["tests"]:
            lines.append(f"- `{test['command']}` -> exit {test['exit']}: {test['summary']}")
    else:
        lines.append("- nothing: `--skip-tests` was used, so this release claims nothing was run.")
    lines.append("")
    lines.append(
        "The same checks run from a clone with `make test` (and `make smoke` for beta and "
        "above).  Every line above is copied out of the real command's own output, not a "
        "summary someone typed."
    )
    lines.append("")

    body = changelog_body(version)
    lines.append("## The changelog entry, verbatim")
    lines.append("")
    lines.append(body if body else "(no `## v%s` section in CHANGELOG.md)" % version)
    lines.append("")

    lines.append("## What this release does not claim")
    lines.append("")
    if info["channel"]:
        article = "an" if info["channel"][0].lower() in "aeiou" else "a"
        lines.append(
            f"- {version} is {article} {info['channel']} build: the interface may still change, and "
            "the 0.x line has no GA and no LTS (docs/RELEASING.md)."
        )
    if channel == "alpha":
        lines.append("- There is no binary bundle and no installer on this channel.")
    elif info["major"] < MSI_MIN_MAJOR:
        lines.append(
            f"- No MSI: the installer is for {MSI_MIN_MAJOR}.0.0 and above, and this is "
            f"{info['major']}.x."
        )
    lines.append(
        "- Windows only: the kernel's platform layer is core/port/sys_win32.c and "
        "core/port/proc_win32.c.  The shell needs Node.js 24 or newer."
    )
    if context["skipped_smoke"]:
        lines.append(
            "- `make smoke` skipped (no browser on this machine): the window rendered, and the "
            "keyboard, were not exercised for this release."
        )
    if context["branch_waived"]:
        lines.append(
            f"- The branch rule was waived (`--allow-branch`): a {channel} release belongs on "
            f"`{context['branch']}`, and this one was cut from `{context['branch_now']}`."
        )
    if context["args"].no_freeze:
        top = changelog_top()
        if top == "Unreleased":
            lines.append(
                "- The changelog was not dated (`--no-freeze`): the section quoted below is still "
                "`## Unreleased`."
            )
        else:
            lines.append(
                "- The changelog was not re-dated (`--no-freeze`): the section quoted below is "
                f"`## {top}`."
            )
    if context["msi_note"]:
        lines.append(f"- {context['msi_note']}")
    lines.append(
        "- The workflow files call this same script; their run history is the repository's "
        "Actions tab, not a claim in these notes."
    )
    if not context["remotes"]:
        lines.append(
            "- Nothing was pushed by this run (`--push` was not given) and no remote was "
            "configured when it was cut: the archive and the tag are local artifacts."
        )
    lines.append("")
    lines.append("## How to reproduce this directory")
    lines.append("")
    lines.append("```")
    for command in context["reproduce"]:
        lines.append(command)
    lines.append("```")
    lines.append("")
    return "\n".join(lines)


def manifest(context: dict) -> str:
    """The machine-readable half of the notes."""
    info = context["info"]
    data = {
        "schema": "seide.release/1",
        "version": info["version"],
        "channel": context["channel"],
        "stage": "pre-release" if info["channel"] else "release",
        "fork": context["fork"],
        "tag": context["tag"],
        "tagged": context["tagged"],
        "branch": context["branch"],
        "branch_rule_waived": context["branch_waived"],
        "changelog_frozen": not context["args"].no_freeze,
        "commit": context["base"]["commit"],
        "commit_date": context["base"]["date"],
        "commit_subject": context["base"]["subject"],
        "generated": context["generated"],
        "artifacts": sorted(context["artifacts"], key=lambda item: item["name"]),
        "tests": context["tests"],
        "tested": bool(context["tests"]),
        "msi": context["msi"],
        "msi_note": context["msi_note"],
        "toolchain": context["toolchain"],
        "remotes": context["remotes"],
        "reproduce": context["reproduce"],
        "policy": "docs/RELEASING.md",
    }
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# the pipeline
# ---------------------------------------------------------------------------


def banner(step: str, title: str) -> None:
    """A step header, so a long run stays readable."""
    print("")
    print(f"--- {step}: {title} " + "-" * max(0, 66 - len(step) - len(title)))


def plan(args, info: dict, channel: str) -> dict:
    """Everything the release will do, decided before anything is written.

    --dry-run prints this and stops, which is also how the gates are rehearsed
    without touching a tag.
    """
    fork = args.fork or ""
    fork_data = fork_manifest(fork) if fork else {}
    if fork and channel not in ("final", "lts") and not args.dry_run:
        # The fork bundle belongs to the channels that ship one; a rehearsal
        # (--dry-run) is allowed to look at any of them.
        raise ReleaseError(
            f"a fork ships with a final or LTS release, not {channel}: forks are for 1.x GA "
            "and after (docs/RELEASING.md) -- --dry-run plans it anyway",
            3,
        )
    if args.no_msi and args.with_msi:
        raise ReleaseError("--no-msi and --with-msi say opposite things", 3)
    branch = expected_branch(channel, info)
    tag = tag_name(fork, info["version"])
    dist = Path(args.dist) if args.dist else DIST_ROOT / info["version"]
    if not dist.is_absolute():
        dist = REPO_ROOT / dist
    if fork:
        dist = dist / fork
    stem = f"seide-{fork}" if fork else "seide"
    artifact_kinds = list(CHANNELS[channel]["artifacts"])
    wants_msi = channel in ("final", "lts") and info["major"] >= MSI_MIN_MAJOR and not args.no_msi
    return {
        "args": args,
        "info": info,
        "channel": channel,
        "fork": fork,
        "fork_data": fork_data,
        "branch": branch,
        "tag": tag,
        "dist": dist,
        "stem": stem,
        "artifact_kinds": artifact_kinds,
        "wants_msi": wants_msi,
        "with_msi": bool(args.with_msi),
        "no_msi": bool(args.no_msi),
        "test_targets": tuple(args.tests) if args.tests else CHANNELS[channel]["tests"],
        # Filled in by the step that decides each, so the notes can never claim
        # a step ran when it did not.
        "branch_now": branch,
        "branch_waived": False,
        "freeze_note": "",
        "tag_existed": False,
    }


def preflight(context: dict) -> None:
    """Every gate that can be checked before a single byte is written."""
    args, info = context["args"], context["info"]
    banner("1/5", "preflight")

    code = version_tool.cmd_check(quiet=True)
    if code != 0:
        raise ReleaseError("tools/version.py check is red: fix the version copies first")
    print(f"[ok   ] VERSION {info['version']} agrees with every copy")

    make = build_tool.find_tool(build_tool.MAKE_NAMES, "MAKE")
    gcc = build_tool.find_tool(build_tool.GCC_NAMES, "GCC")
    if make is None:
        raise ReleaseError("no make found (install MinGW-w64, or set MAKE)", 2)
    context["make"], context["gcc"] = make, gcc
    print(f"[ok   ] make {make}")
    if gcc is None and "test" in context["test_targets"]:
        raise ReleaseError("no gcc found (install MinGW-w64, or set GCC)", 2)

    branch = git_text("rev-parse", "--abbrev-ref", "HEAD").strip()
    context["branch_now"] = branch
    want = context["branch"]
    context["branch_waived"] = branch != want
    if branch != want:
        if args.allow_branch:
            print(f"[warn ] HEAD is on {branch}, not {want} (--allow-branch): rehearsal only")
        else:
            raise ReleaseError(
                f"HEAD is on {branch!r}; a {context['channel']} release is cut from {want!r} "
                f"(git switch -c {want}) -- docs/RELEASING.md has the branch model"
            )
    else:
        print(f"[ok   ] on branch {want}")

    if not is_clean():
        # A dry run is the one mode where a dirty tree is useful rather than
        # disqualifying: it is how the plan is rehearsed before the commit.
        if args.dry_run:
            print("[warn ] the tree has uncommitted changes (--dry-run plans anyway)")
        else:
            raise ReleaseError("the tree has uncommitted changes; a release is cut from a commit")
    else:
        print("[ok   ] the tree is clean")

    tag = context["tag"]
    code, _ = git("rev-parse", "-q", "--verify", f"refs/tags/{tag}")
    context["tag_existed"] = code == 0
    if args.no_tag:
        # --no-tag says the tag is not this run's business.  That is the CI
        # case: the tag was pushed, and the runner is asked for the notes and
        # the artifacts that belong to it -- refusing because it exists would
        # make the whole workflow impossible.
        state = "already exists" if code == 0 else "does not exist yet"
        print(f"[ok   ] --no-tag: tag {tag} {state}; this run will not touch it")
    elif code == 0:
        raise ReleaseError(f"tag {tag} already exists; pick the next version (tools/version.py bump)")
    else:
        print(f"[ok   ] tag {tag} is free")

    if args.push and not remote_names():
        raise ReleaseError("--push was given but this repository has no remote configured")
    context["remotes"] = remote_names()
    if not args.no_tag:
        print(f"[ok   ] will tag {tag} (annotated) on the release commit")

    if args.dry_run:
        # A dry run writes nothing, and that includes the directory it would
        # have put the artifacts in.
        print(f"[plan ] distribution directory {context['dist']}")
    else:
        context["dist"].mkdir(parents=True, exist_ok=True)
        print(f"[ok   ] distribution directory {context['dist']}")


def verify(context: dict) -> None:
    """Run the suites this channel promises, in the order the Makefile has them."""
    args = context["args"]
    banner("2/5", "verify")
    if args.dry_run:
        for target in context["test_targets"]:
            print(f"[plan ] {context['make']} -f Makefile CC={context['gcc']} {target}")
        return
    if args.skip_tests:
        print("[skip ] --skip-tests: the notes will say nothing was run")
        return
    make, gcc = context["make"], context["gcc"]
    for target in context["test_targets"]:
        command = [make, "-f", "Makefile"]
        if gcc is not None:
            command.append("CC=" + str(gcc).replace("\\", "/"))
        command.append(target)
        code, output = run(command, timeout=args.test_timeout)
        summary = result_summary(output)
        context["tests"].append(
            {"name": target, "command": " ".join(str(part) for part in command), "exit": code, "summary": summary}
        )
        if code != 0:
            print(output.rstrip())
            raise ReleaseError(f"make {target} failed (exit {code})")
        if target == "smoke" and "skip" in output.lower():
            context["skipped_smoke"] = True
        print(f"[ok   ] make {target}: {summary}")


def freeze(context: dict) -> None:
    """Commit the changelog for this version, so the tag can name itself."""
    args, info = context["args"], context["info"]
    banner("3/5", "freeze the changelog")
    context["freeze_note"] = ""
    if args.no_freeze:
        context["freeze_note"] = "not dated: --no-freeze was given"
        print("[skip ] --no-freeze: the changelog keeps whatever section it has")
        return
    if args.dry_run:
        print(f"[plan ] rename '## Unreleased' to '## v{info['version']} \u2014 {datetime.date.today().isoformat()}' and commit it")
        return
    changed = freeze_changelog(info["version"], datetime.date.today().isoformat())
    context["freeze_note"] = (
        f"dated '## v{info['version']}'" if changed else f"already dated '## v{info['version']}'"
    )
    if not changed:
        return
    git("add", "CHANGELOG.md")
    message = f"Release {info['version']}\n\nFrozen by tools/release.py: the tag names this tree,\nso the changelog does too.\n"
    message_file = REPO_ROOT / "build" / "release-msg.txt"
    message_file.parent.mkdir(parents=True, exist_ok=True)
    write_text(message_file, message)
    code, output = git("commit", "-F", str(message_file))
    if code != 0:
        raise ReleaseError(f"cannot commit the frozen changelog: {output.strip()}")


def cut_artifacts(context: dict) -> None:
    """Build what this channel is allowed to ship."""
    args, info = context["args"], context["info"]
    channel, fork = context["channel"], context["fork"]
    banner("4/5", "artifacts")
    dist, stem = context["dist"], context["stem"]
    rev = "HEAD"
    artifacts = []

    if args.dry_run:
        print(f"[plan ] build the kernel: {context['make']} -f Makefile")
        for kind in context["artifact_kinds"]:
            if kind == "src":
                print(f"[plan ] src: {dist / (stem + '-' + info['version'] + '-src.zip')} "
                      "(git archive --format=zip --prefix=" + stem + "-" + info["version"] + "/)")
            else:
                print(f"[plan ] bundle: {dist / (stem + '-' + info['version'] + '-win64.zip')} "
                      f"({' + '.join(BUNDLE_TREES)} + {BUNDLE_FILES[0]} + {BUNDLE_KERNEL} + START-HERE.txt)")
        if fork:
            print(f"[plan ] fork: {dist / (stem + '-' + info['version'] + '-fork.zip')} "
                  f"(forks/{fork}/ plus APPLY.md)")
        if context["wants_msi"] or context["with_msi"]:
            print(f"[plan ] msi: {sys.executable} {MSI_BUILD} --bundle <staged bundle> "
                  f"--version {info['version']} --out {dist / ('seide-' + info['version'] + '-win64.msi')}")
        print("[plan ] SHA256SUMS, RELEASE-NOTES.md, manifest.json")
        return

    code, _ = run([context["make"], "-f", "Makefile"], capture=False)
    if code != 0:
        raise ReleaseError(f"the build failed (exit {code})", code or 1)
    if not (REPO_ROOT / BUNDLE_KERNEL).is_file():
        raise ReleaseError(f"the build produced no {BUNDLE_KERNEL}", 2)

    if "src" in context["artifact_kinds"]:
        dest = dist / f"{stem}-{info['version']}-src.zip"
        artifacts.append(source_archive(stem, info["version"], rev, dest))
        print(f"[ok   ] {dest.name} ({artifacts[-1]['bytes']} bytes)")

    items = None
    if "bundle" in context["artifact_kinds"]:
        items = bundle_items(info["version"], channel, info, fork, context["no_msi"])
        dest = dist / f"{stem}-{info['version']}-win64.zip"
        artifacts.append(write_zip(dest, items))
        print(f"[ok   ] {dest.name} ({artifacts[-1]['bytes']} bytes)")

    if fork and not context["fork_data"].get("no_fork_zip"):
        dest = dist / f"{stem}-{info['version']}-fork.zip"
        artifacts.append(build_fork_zip(info["version"], fork, context["fork_data"], context["base"], dest))
        print(f"[ok   ] {dest.name} ({artifacts[-1]['bytes']} bytes)")

    if context["wants_msi"] or context["with_msi"]:
        if items is None:
            items = bundle_items(info["version"], channel, info, fork, context["no_msi"])
        staging_parent = REPO_ROOT / "build" / "staging" / info["version"]
        try:
            staging = write_staging(items, staging_parent / "bundle")
            made = build_msi(info["version"], staging, dist / f"seide-{info['version']}-win64.msi")
        except ReleaseError as exc:
            if context["wants_msi"]:
                raise
            context["msi_note"] = f"No MSI (--with-msi was given, but the step did not produce one): {exc}"
            print(f"[skip ] msi: {exc}")
        else:
            artifacts.append(made)
            context["msi"] = {"name": made["name"], "sha256": made["sha256"]}
            print(f"[ok   ] {made['name']} ({made['bytes']} bytes)")
        finally:
            shutil.rmtree(staging_parent, ignore_errors=True)
    context["artifacts"] = artifacts


def tag_release(context: dict) -> None:
    """Tag the release commit -- locally, unless --push says otherwise."""
    args = context["args"]
    banner("5/5", "tag")
    if args.dry_run:
        print(f"[plan ] git tag -a {context['tag']} (annotated, on the release commit)")
        return
    if args.no_tag:
        print("[skip ] --no-tag: the artifacts exist, the release is not named")
        return
    context["base"] = commit_info("HEAD")
    # The annotation must describe a tag that exists.  The copy the notes are
    # rendered from says so before `git tag -a` runs; rendering first is how
    # every earlier annotation came to say "(NOT created: --no-tag)".
    message_context = dict(context)
    message_context["tagged"] = True
    notes = release_notes(message_context)
    message_file = REPO_ROOT / "build" / "release-tag.txt"
    message_file.parent.mkdir(parents=True, exist_ok=True)
    write_text(message_file, f"{context['tag']}\n\n" + notes.split("## What was checked")[0].strip() + "\n")
    code, output = git("tag", "-a", context["tag"], "-F", str(message_file))
    if code != 0:
        raise ReleaseError(f"cannot create tag {context['tag']}: {output.strip()}")
    context["tagged"] = True
    print(f"[ok   ] tagged {context['tag']} on {context['base']['commit'][:12]}")

    if args.push:
        for ref in (context["branch"], context["tag"]):
            code, output = git("push", "origin", ref)
            if code != 0:
                raise ReleaseError(f"git push origin {ref} failed: {output.strip()}")
    else:
        print("[note ] nothing was pushed; --push sends the branch and the tag to origin")


def write_outputs(context: dict) -> None:
    """Write SHA256SUMS, RELEASE-NOTES.md and manifest.json next to the artifacts."""
    if context["args"].dry_run:
        return
    dist = context["dist"]
    context["generated"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    context["toolchain"] = tool_versions()
    sums = dist / "SHA256SUMS"
    write_text(sums, sha256sums(context["artifacts"]))
    notes = dist / "RELEASE-NOTES.md"
    write_text(notes, release_notes(context))
    data = dist / "manifest.json"
    write_text(data, manifest(context))
    print(f"[ok   ] {sums.name}, {notes.name}, {data.name}")


def report(context: dict) -> str:
    """Verification of what is on disk, then the next step for the human."""
    args, info = context["args"], context["info"]
    lines = []
    if not args.dry_run:
        dist = context["dist"]
        for artifact in context["artifacts"]:
            path = dist / artifact["name"]
            if not path.is_file():
                raise ReleaseError(f"{path} vanished after being written")
            if file_sha256(path) != artifact["sha256"]:
                raise ReleaseError(f"{path} changed on disk after it was hashed")
            if path.suffix == ".zip":
                with zipfile.ZipFile(path) as archive:
                    count = len(archive.namelist())
                print(f"[ok   ] {artifact['name']}: {count} entries, hash re-read and equal")
            else:
                print(f"[ok   ] {artifact['name']}: hash re-read and equal")
        lines.append("")
        lines.append(f"release directory: {dist}")
        for artifact in sorted(context["artifacts"], key=lambda item: item["name"]):
            lines.append(f"  {artifact['name']:<44} {artifact['bytes']:>10} bytes  {artifact['sha256'][:16]}...")
    lines.append("")
    if not context["tagged"] and not args.dry_run:
        lines.append("the release is NOT named: no tag was created (--no-tag)")
    lines.append("next:")
    lines.append("  - to start the next line: python tools/version.py bump  (then add '## Unreleased' to CHANGELOG.md)")
    if context["channel"] == "alpha":
        lines.append("  - to promote to beta: git switch -c release/%d.%d, then version.py bump beta" % (info["major"], info["minor"]))
    if info["major"] < LTS_MIN_MAJOR:
        lines.append("  - LTS waits for %d.0.0 (docs/RELEASING.md); the 0.x line does not open one" % LTS_MIN_MAJOR)
    return "\n".join(lines)


def cut(args) -> int:
    """The whole pipeline, in the order the docstring promises."""
    info = version_now()
    channel = resolve_channel(info, args.channel)
    context = plan(args, info, channel)
    context.update(
        {
            "tests": [],
            "artifacts": [],
            "msi": None,
            "msi_note": (
                "The installer was not built (`--no-msi`): this release claims the source, the "
                "bundle and the fork, not an MSI."
                if args.no_msi and context["channel"] in ("final", "lts") and info["major"] >= MSI_MIN_MAJOR
                else ""
            ),
            "skipped_smoke": False,
            "tagged": False,
            "remotes": [],
            "reproduce": [f"python tools/release.py --channel {channel}"],
        }
    )
    if args.dry_run:
        context["base"] = commit_info("HEAD")

    print(f"release: seIDE {info['version']} ({channel})" + (f" fork {context['fork']}" if context["fork"] else ""))
    print(f"tag    : {context['tag']}")
    print(f"dist   : {context['dist']}")
    print(f"tests  : {', '.join(context['test_targets']) or '(none)'}")
    print(f"dry run: {'yes -- nothing will be written' if args.dry_run else 'no'}")
    if context["fork"] and channel not in ("final", "lts"):
        print(
            f"[warn ] the fork bundle belongs to a final or LTS release; a real {channel} run "
            "refuses --fork (docs/RELEASING.md)"
        )

    preflight(context)
    verify(context)
    freeze(context)
    if not args.dry_run:
        context["base"] = commit_info("HEAD")
    cut_artifacts(context)
    context["reproduce"] = reproduce_commands(context)
    write_outputs(context)
    tag_release(context)
    if not args.dry_run:
        write_outputs(context)  # the tag knows the commit now, so the manifest does too
    print(report(context))
    return 0


def reproduce_commands(context: dict) -> list:
    """The exact commands that produce this directory again."""
    args = context["args"]
    lines = ["git switch --detach " + context["base"]["commit"]]
    commands = [f"python tools/release.py --channel {context['channel']}"]
    if context["fork"]:
        commands[0] += f" --fork {context['fork']}"
    if args.skip_tests:
        commands[0] += " --skip-tests"
    if args.no_tag:
        commands[0] += " --no-tag"
    if args.no_freeze:
        commands[0] += " --no-freeze"
    if args.no_msi:
        commands[0] += " --no-msi"
    lines += commands
    lines.append("python -c \"import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())\" <artifact>")
    return lines


# ---------------------------------------------------------------------------
# command line
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="release.py",
        description="Cut a release: preflight, verify, freeze the changelog, build the artifacts, tag. "
        "Exit codes: 0 ok, 1 a gate failed, 2 a tool is missing, 3 usage.",
    )
    parser.add_argument("--channel", choices=CHANNEL_NAMES, default="", help="default: whatever VERSION's suffix says")
    parser.add_argument("--fork", default="", metavar="NAME", help="release forks/NAME instead of the base IDE")
    parser.add_argument("--dry-run", action="store_true", help="print the whole plan and write nothing")
    parser.add_argument("--no-tag", action="store_true", help="build the artifacts, do not create the tag")
    parser.add_argument("--no-freeze", action="store_true", help="do not date the changelog section")
    parser.add_argument("--skip-tests", action="store_true", help="do not run the suites (the notes will say so)")
    parser.add_argument("--with-msi", action="store_true", help="try the MSI step even below 1.x")
    parser.add_argument(
        "--no-msi",
        action="store_true",
        help="skip the MSI step a 1.x final or LTS release would require, and say so in the notes",
    )
    parser.add_argument("--push", action="store_true", help="push the branch and the tag to origin")
    parser.add_argument("--allow-branch", action="store_true", help="rehearse on a branch this channel does not own")
    parser.add_argument(
        "--tests",
        action="append",
        default=[],
        choices=("test", "smoke"),
        help="override the suite list (repeatable); the default comes from the channel",
    )
    parser.add_argument("--dist", default="", metavar="DIR", help="where the release directory goes (default dist/)")
    parser.add_argument("--test-timeout", type=int, default=1800, metavar="SECONDS", help="per-suite timeout")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    try:
        return cut(args)
    except ReleaseError as exc:
        print(f"release.py: FAIL {exc}", file=sys.stderr)
        return exc.code
    except KeyboardInterrupt:
        print("release.py: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
