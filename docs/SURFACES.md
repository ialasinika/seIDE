# Surfaces — non-text editing, and the hook that makes it cheap

A card on the board is called a **surface**: a rectangle in the canvas that owns
some state and knows how to edit it. Nothing in seIDE assumes that state is a
string of source text.

This document is about the one hook the shell exposes for new surfaces, and
about the shipped counterexample (`sheet`) that keeps the hook honest.

---

## 1. Why this exists

Most IDEs are a text editor with a sidecar. Fork one and you inherit that
assumption in a hundred places: the model is a buffer, the undo stack is a
character range, the protocol carries strings, the persistence layer writes
text. A fork that wants to edit a *shader graph*, a *level layout*, an *audio
envelope*, a *database row set* or a *build matrix* spends its first month
fighting the host instead of building the product.

seIDE makes the opposite bet. The board is a canvas of surfaces; a text editor
is just one surface kind among several. The toolkit ships:

- a kernel that stores a card's payload **verbatim** and validates only its
  *shape* (`id`, `kind`, `x`, `y`, `w`, `h`),
- a protocol whose card payload is arbitrary nested JSON, not a string,
- a board model that deep-clones payloads without inspecting them,
- one registration function that turns "a new kind" into a self-contained
  object.

## 2. The hook

```js
import { registerCardKind } from "./cards.mjs";

registerCardKind({
  kind: "waveform",                       // must equal card.kind on the wire
  title: "Waveform",                      // human name, for the board's own UI
  create: () => ({ samples: [], rate: 8000 }),
  describe: (card) => `waveform ${card.samples.length} samples`,
  render: (card, ctx) => { /* -> {el, handle, destroy} */ },
});
```

That is the whole extension mechanism — **one call, one object**. There is no
manifest, no loading, no discovery, no sandbox, no version negotiation and no
registry file to edit. A fork adds its calls to `shell/web/cards.mjs` or to a
module it imports next to it.

| member | required | contract |
|---|---|---|
| `kind` | yes | non-empty string; must equal `card.kind` |
| `render` | yes | `(card, ctx) => {el, handle, destroy}` |
| `title` | no | string; defaults to `kind` |
| `describe` | no | `card => string`, one line for the board header; **must not throw** |
| `create` | no | `() => object`; the extra fields a *new* card starts with |
| `replace` | no | `true` to override an already-registered kind |

`render` receives `ctx = {client, app}` — the only way out of a card:

- `ctx.client.call(method, params)` — the JSON-RPC client
- `ctx.app.boardTouched(true)` — mark the board dirty (triggers the save)
- `ctx.app.log(level, message)` — write to the command-line log
- `ctx.app.openFile(path)`, `ctx.app.registerRun(...)`, `ctx.app.confirmDiscard(path)`

A renderer **mutates its own card object** (`card.doc`, `card.samples`, …) and
then calls `app.boardTouched(true)`. Persistence, dirty tracking and
`board.json` need nothing else from it.

`registerCardKind` throws on a malformed spec, and throws when re-registering an
existing kind without `replace: true`, so a fork that means to override a
built-in has to say so. The returned spec is frozen.

Look up what is registered with `knownCardKinds()` and `cardKind(kind)`.

### The renderer's return value

```js
{
  el,                     // the card's DOM element
  handle: {               // optional
    kind,                 //   echoed in the board header
    focus(),              //   called when the card is selected
    refresh(),            //   free-form; the command line may call it
  },
  destroy(),              // release timers, sockets, subscriptions
}
```

Use the shared chrome so a new surface looks like every other card:

```js
const body = h("div", "card-body card-body-waveform", { children: [canvas] });
const shell = cardShell(card, body);   // title bar (drag handle) + corner grip
shell.label.textContent = "…";         // the line next to the kind name
return { el: shell.el, handle: { kind: "waveform", focus() {} }, destroy() {} };
```

## 3. The shipped counterexample: `sheet`

`sheet` is not a textarea with a fancy label. Its state is a nested object:

```json
{
  "kind": "sheet",
  "w": 460, "h": 320, "x": 720, "y": 300, "z": 3,
  "title": "parse results",
  "doc": {
    "columns": [
      { "id": "key",   "title": "key",   "type": "text"   },
      { "id": "count", "title": "count", "type": "number" },
      { "id": "done",  "title": "done",  "type": "bool"   },
      { "id": "mood",  "title": "mood",  "type": "choice", "options": ["calm", "busy"] }
    ],
    "rows": [
      { "id": "r1", "cells": { "key": "a", "count": 3, "done": true, "mood": "calm" } },
      { "id": "r2", "cells": { "key": "b", "count": 0, "done": false, "mood": "busy" } }
    ]
  }
}
```

What it demonstrates:

- **Typed cells, not characters.** `text`, `number`, `bool` and `choice` columns
  render as an input, a right-aligned numeric input, a toggle and a select.
- **Structural edits.** Add/remove rows and columns; changing a column's type
  re-coerces every cell under it. The last column cannot be deleted; the last
  row can.
- **Keyboard grid navigation.** Arrows and `Enter` move between cells and clamp
  at the edges; `ArrowLeft`/`ArrowRight` only leave a text cell when the caret is
  already at the boundary, so ordinary text editing still works.
- **A non-text exit.** `TSV` copies the whole grid out as tab-separated text —
  to the clipboard, or to the log if the clipboard is unavailable. That is how
  structured state is handed to a runner card, an editor card or a file.
- **No text fallback anywhere.** The card never serialises its state to render
  it, and `core/` never sees the payload as anything but JSON.

The model is pure and unit-tested without a DOM:
`emptySheet`, `normaliseSheet`, `coerceSheetValue`, `sheetCell`, `setSheetCell`,
`addSheetRow`, `removeSheetRow`, `addSheetColumn`, `removeSheetColumn`,
`sheetSummary`, `sheetToTSV`, `nextSheetSelection`, `SHEET_TYPES`.

```
node shell/web/selftest.mjs      # includes 13 checks over the hook and the sheet model
```

A second worked example is in [`PROJECT.md`](PROJECT.md): the `project` card
merges the kernel's `workspace.list` with the board's own editor cards, so a
kind can depend on *both* the filesystem and the board without changing either.

A third is the `search` card: it is the one kind that is pure *consumer* — it
calls `workspace.list` and `file.read`, keeps its own query/glob/case fields on
the board, and hands a hit back to another card kind (`app.openFile(path, {line})`
lands in an `editor` card) instead of rendering the file itself. Its arithmetic
(`searchInText`, `searchExcerpt`, `searchFiles`) is exported and pure, which is
what let the budgets be a tested part of the answer rather than a comment.

## 4. What the rest of seIDE guarantees a new surface

| layer | guarantee | where |
|---|---|---|
| kernel (`core/`) | stores the view document verbatim, whatever its shape — no field is read, no kind is known | `core/src/view.c` |
| protocol | a card payload is arbitrary nested JSON; unknown kinds are never rejected | `docs/PROTOCOL.md` |
| board model | deep-clones payloads (`cloneDocument`) and never interprets them | `shell/web/board.mjs` |
| board UI | an unregistered kind renders as an "unknown card" that is **preserved, not deleted** | `renderUnknown` in `shell/web/cards.mjs` |
| command line | `focus`, `delete`, `link` work on any card id regardless of kind | `shell/web/main.mjs` |

The last two matter: add a kind to a `board.json` and open it in a build that
does not have the renderer, and you get a placeholder card that still pans,
still links, still saves. Nothing is lost. That is what makes it safe for a fork
to invent kinds.

## 5. Honest limits

- **Register at load time.** There is no runtime loading, no `import()` of a
  user directory, no plugin search path. Registration happens while the shell
  module graph is evaluated. That is the point — the requirement is "cheap to
  fork", not "extensible without forking".
- **No schema or version negotiation.** A card's payload is whatever its
  renderer writes. Write a `normaliseMyKind(doc)` that repairs garbage instead
  of throwing, the way `normaliseSheet` does; the board already preserves cards
  written by older or buggier builds, and the renderer is the only place that
  can make sense of them.
- **No sandbox.** A renderer is ordinary module code with full DOM access.
- **`CARD_KINDS` in `board.mjs` is documentation.** The runtime source of truth
  is `knownCardKinds()`.
- **One surface per kind.** Kind is a string on the card, so two cards of the
  same kind share a renderer; per-card variation belongs in the payload.

## 6. What a fork typically does

| fork wants | the work |
|---|---|
| a diff viewer | one kind; `render` builds two token-coloured `<pre>`s and a gutter |
| a map/level editor | one kind; state is `{tiles, w, h}`; `render` paints a `<canvas>` and binds pointer gestures |
| a database browser | one kind; `render` calls `workspace.list`-style RPCs on a new kernel method |
| a form-based config editor | `sheet`, unchanged, with a tighter column type set |
| a second text language | **no kind at all** — drop a `.lang` descriptor into `langs/` |
| a language server: completion, diagnostics, hover, definition, format | **no kind at all** — a `.sub` descriptor in `subsystems/` and a module; the editor card already asks, and picks its subsystem from the declared capabilities |
| a different note card | `registerCardKind({kind: "note", replace: true, …})` |

The first six need no C, no protocol change and no board-model change. Only a
new *kernel capability* (a new filesystem or process query) touches `core/`.
