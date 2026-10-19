# The project card

seIDE has one workspace and one project: the tree the kernel was pointed at. The
`project` card is the surface that treats it as **one project** rather than as a
list of files — it answers two questions in the same panel:

- what is in this project (a tree, folded by folder, filtered), and
- what do I already have open in it (the editors on the board).

That second question is the reason the card exists. Where the `files` card is a
file browser — it lists whatever you point it at, folder by folder — the project
panel is the one surface that knows the *whole* project at once and can therefore
say something the browser cannot: **this card is open on a file that is no longer
there.**

Open the panel with `project` (optionally `project core/src/*.c` to start with a
filter already applied). It is a card like any other: move it, resize it, link
it, delete it. Where it sits is part of the board, and the board is part of the
project state.

## What it shows

```
workspace — C:\work\seIDE
[ **/*                       ] [ refresh ]

OPEN · 2
  ●  rpc.c            core/src/ · unsaved        ×
  ●  board.c          core/src/                  ×

(Root)
     README.md                              8.2K 2d
CORE/SRC/
  ○  board.c                                24K 30s
     rpc.c                                  31K 30s
EXAMPLES/
     hello.bf                               820B 3d
6 files · 1 folders · 2 open · 1 unsaved
```

- **One row per file**, grouped by folder, with size and age from the kernel's
  listing. Folders are the grouping, so a directory entry never becomes a row.
- **`●` marks a file that is open** on the board (and the row is tinted when
  that card has unsaved text); clicking a row reveals the existing card or opens
  a new one. `×` takes a card off the board — the file is not touched, and the
  tooltip says so.
- **A directory the kernel skips is named, not faked.** `build/`, `.git/`,
  `.seide/`, `node_modules/` and the rest never appear in a listing at all — the
  kernel skips those names while it walks (see below) — so the panel reports
  them from `workspace.info.ignored` in the root line's tooltip, and names them
  again when a filter matches nothing. Nothing is ever hidden by this side.
- **A missing file is named.** An editor whose path is not in the listing is
  reported as `file is gone`; nothing is silently kept or silently dropped.
- **The status line is a sentence, not a decoration**: file count, open count,
  unsaved count, and a warning when the listing was truncated.

## Why it is a card and not a side panel

A side panel would be the obvious shape if the board were a document list. It is
not: the board is a 2-D plane, and "what the panel looks like" is exactly the
kind of state this project keeps *in the board* — position, size, stacking, and
which cards are next to which. A project panel that lived outside the board
would be the one part of the workspace you could not arrange, and the one part
that saved separately from everything else.

A card it remains even in the classic view: `mode classic` draws this card in the
left column, but the column is a *measurement* of that card for the duration of
the mode — the card is still the thing, and `mode board` puts it back on the
plane. See [`PARADIGM.md`](PARADIGM.md).

It is also why the panel's own state is on the card:

| field | meaning |
| --- | --- |
| `filter` | the glob, default `**/*` |

It round-trips through `.seide/board.json` with the geometry, because the board
model in `shell/web/board.mjs` clones any field it does not interpret — and the
kernel, which stores the whole document without reading it, clones everything
([`VIEWS.md`](VIEWS.md)).

## Why some directories are missing, and why the panel does not fix that

`workspace.list` skips whole directories by name while it walks. The table lives
in `core/src/wksp.c`:

```
.git  .seide  .hg  .svn  node_modules  __pycache__
.vscode  .idea  .cache  dist  build  target  obj
```

Those are either state derived from the project or bookkeeping belonging to
another tool, and the call has no flag to ask for them. So there is exactly one
answer to "where is `build/`?" — the kernel's — and the browser cannot contradict
it: a second ignore list on this side could only ever disagree with the one in C,
and would silently drop rows a forked kernel did hand over. `workspace.info`
reports the names as `ignored`, which is what the tooltip and the empty state
quote back.

## Why it lists the whole workspace

The panel asks the kernel for `**/*` and filters in the browser. That looks
backwards — the kernel could filter for it — and it is deliberate: the useful
judgement ("this open card points at a file that is gone") needs the *whole*
project, not the subset the filter happens to show. Filtering server-side would
make a filtered view quietly claim that a missing file exists.

The cost is honest and bounded: one `workspace.list` call per refresh, capped at
4000 entries. When the listing hits that cap the kernel says `truncated`, the
panel repeats it, and the missing-file claim is downgraded to a warning rather
than a fact.

## What it does not do

- **No writes.** It opens files and reveals cards; nothing in the panel edits,
  renames, moves or deletes a file. The `files` card does not either, and the
  kernel's `workspace.write` is still only reachable through an editor card.
- **No recursive "open all".** Convenience that hides how many cards it makes is
  how a board becomes a tab bar.
- **No per-folder collapse state.** Grouping is by folder and every group is
  open; the filter is the tool for reducing what you see, and it is a card field
  rather than scroll position, so it survives a reload.
- **No file watching.** A refresh is a refresh: `refresh`, reopening the card,
  or a change in what the board has open. Watching the workspace would mean a
  second source of truth about the filesystem, and stale rows would then be a
  bug rather than a button.

## Under the hood

| piece | where |
| --- | --- |
| `projectRows(listing, {open, filter, now})` | `shell/web/cards.mjs`, pure |
| `projectSummary(counts)` | `shell/web/cards.mjs`, pure |
| `dirNameOf` | `shell/web/cards.mjs`, pure |
| `renderProject(card, ctx)` | `shell/web/cards.mjs`, DOM |
| registration + command + help text | `shell/web/cards.mjs`, `shell/web/main.mjs` |
| default size `{w: 340, h: 580}` | `shell/web/board.mjs` |

The pure half is what `shell/web/selftest.mjs` drives under Node; the DOM half
gets its context through `ctx.app`, so the panel never talks to the kernel
directly. It asks for four things the board does not otherwise expose —
`openEditors()`, `revealCard(id)`, `closeCard(id)` and `workspace()` (the
`workspace.info` reply, read once at boot) — plus `onBoardChanged(fn)`, which
fires **only when the set of open editors changes**, not on every frame of a pan.

Because the board is painted before `workspace.info` answers, a project card that
is already on screen is told to re-read it once the reply lands
(`shell/web/main.mjs`, in `boot`); without that the panel would keep its
"the path was not reported by the kernel" line for the rest of the session.
