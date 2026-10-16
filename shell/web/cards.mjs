/**
 * cards.mjs -- one renderer and one behaviour set per card kind.
 *
 * DELETE THIS FILE and the board still pans; it just has no cards to put on it.
 * seIDE has no plugin system: extending the visual vocabulary means forking this
 * file.  What it does have is a *hook* -- `registerCardKind()` -- so that
 * "adding a kind" is one self-contained object instead of an edit to a switch
 * in three places.  Eight kinds are registered at the bottom of this file:
 * `editor`, `runner`, `note`, `files`, `search`, `project`, `sheet` and
 * `frame`.
 *
 * `sheet` is there to make the hook honest rather than theoretical.  It is a
 * structured-data editor -- typed cells in a grid, not a textarea -- and it
 * exists to prove that nothing in the board, the protocol or the kernel assumes
 * a card's state is text.  See `docs/SURFACES.md`.
 *
 * `files` answers "what is in this folder"; `project` answers "what is in this
 * *project*, and what do I have open in it".  The second question is the one
 * that makes many-file editing cheap, which is why the panel lists the whole
 * workspace and merges it with the board's editor cards.  See
 * `docs/PROJECT.md`.
 *
 * The file is split in two halves:
 *
 *   1. pure functions (no `document`, no `window`) -- token spans, the file
 *      listing, command parsing, output buffering, the sheet model.  These are
 *      what `selftest.mjs` checks under Node.
 *   2. DOM renderers, each returning `{ el, handle, destroy }`, driven through
 *      the `ctx` object so a card never talks to the kernel directly.
 *
 * Token colours are applied to a `<pre>` that sits *under* a transparent
 * `<textarea>`, never by rewriting the text itself.  That is what makes the
 * caret survive re-tokenisation: the element being edited is never touched.
 * The cost is that both layers must share identical metrics (see `style.css`)
 * and that the pre must be scrolled in lockstep with the textarea.
 */

import { LanguageClient, formatDiagnostic, insertCompletion } from "./language.mjs";

/**
 * Kinds the wire may carry, mapped to the class suffix `style.css` styles.
 * `ws` and `ident` are emitted by `langs/tokenize.mjs` even though the contract
 * omits them; both are painted as ordinary text rather than dropped.
 */
const KNOWN_KINDS = new Set([
  "comment", "string", "number", "keyword", "type", "constant",
  "command", "punct", "plain",
]);

const PLAIN_LIKE = new Set(["plain", "ws", "ident", ""]);

/**
 * Map a wire token kind onto one of the contract's kinds.
 * Unknown values become `plain` so an unexpected kind can never produce an
 * unstyled hole in the document.
 */
export function normaliseTokenKind(kind) {
  const name = typeof kind === "string" ? kind : "";
  if (PLAIN_LIKE.has(name)) {
    return "plain";
  }
  return KNOWN_KINDS.has(name) ? name : "plain";
}

/**
 * Turn `text` plus a wire token array into a gap-free list of
 * `{start, end, kind}` segments covering `[0, text.length)`.
 *
 * The contract says tokens need not tile the input ("the gaps between them are
 * implicit default-colored text") while `langs/tokenize.mjs` tiles it anyway.
 * This handles both: gaps become `plain`, out-of-range or inverted spans are
 * dropped, and overlapping spans are clipped rather than allowed to nest.
 */
export function applyTokenSpans(text, tokens) {
  const source = typeof text === "string" ? text : "";
  const length = source.length;
  const spans = [];

  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      let start;
      let end;
      let kind;
      if (Array.isArray(token)) {
        [start, end, kind] = token;
      } else if (token !== null && typeof token === "object") {
        start = token.start;
        end = token.end;
        kind = token.kind;
      } else {
        continue;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        continue;
      }
      if (start < 0 || start >= length) {
        continue;
      }
      spans.push({ start, end: Math.min(end, length), kind: normaliseTokenKind(kind) });
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) {
      continue; // fully swallowed by an earlier token
    }
    const start = Math.max(span.start, cursor);
    if (start > cursor) {
      out.push({ start: cursor, end: start, kind: "plain" });
    }
    out.push({ start, end: span.end, kind: span.kind });
    cursor = span.end;
  }
  if (cursor < length) {
    out.push({ start: cursor, end: length, kind: "plain" });
  }
  return out;
}

/** The concatenated text of a segment list; a round-trip check for tests. */
export function segmentsText(text, tokens) {
  return applyTokenSpans(text, tokens).map((seg) => text.slice(seg.start, seg.end)).join("");
}

/** Count segments per kind, e.g. for a status line. */
export function countKinds(segments) {
  const counts = new Map();
  for (const seg of segments) {
    counts.set(seg.kind, (counts.get(seg.kind) || 0) + 1);
  }
  return counts;
}

/** Offset -> 1-based `{line, column}`, for a caret readout. */
export function lineColumn(text, offset) {
  const source = typeof text === "string" ? text : "";
  const at = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, source.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < at; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: at - lastBreak };
}

/* ------------------------------------------------------------------ */
/* file listing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Human-readable size, e.g. `4096` -> `4.0K`.  Byte-exact below 1K, because a
 * source file's real size is more useful than a rounded one.
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/** Relative age, e.g. `3m`, `2h`, `5d`. Empty when the mtime is unusable. */
export function formatAge(mtimeSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(mtimeSeconds)) {
    return "";
  }
  const delta = Math.max(0, nowSeconds - mtimeSeconds);
  if (delta < 60) {
    return `${Math.floor(delta)}s`;
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m`;
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)}h`;
  }
  if (delta < 86400 * 30) {
    return `${Math.floor(delta / 86400)}d`;
  }
  return `${Math.floor(delta / (86400 * 30))}mo`;
}

/**
 * Flatten `workspace.list`'s payload into the rows the `files` card shows:
 * directories first, then files, each group path-sorted.
 *
 * `{files:[{path,size,mtime,dir}], count, truncated}` in, an array of
 * `{path,name,dir,size,mtime,sizeText,ageText}` out.  Pure, so ordering and
 * formatting are testable without a filesystem.
 *
 * @param {object} listing
 * @param {{sort?: "path"|"size"|"mtime", now?: number, dirsFirst?: boolean}} [options]
 */
export function formatListing(listing, options = {}) {
  const { sort = "path", now = Math.floor(Date.now() / 1000), dirsFirst = true } = options;
  const files = listing && Array.isArray(listing.files) ? listing.files : [];

  const rows = [];
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (path === "") {
      continue;
    }
    const dir = entry.dir === true;
    const size = dir ? null : (Number.isFinite(entry.size) ? entry.size : null);
    const mtime = Number.isFinite(entry.mtime) ? entry.mtime : null;
    rows.push({
      path,
      name: path.split("/").pop() || path,
      dir,
      size,
      mtime,
      sizeText: size === null ? "" : formatSize(size),
      ageText: mtime === null ? "" : formatAge(mtime, now),
    });
  }

  const byPath = (a, b) => comparePaths(a.path, b.path);
  const compare = {
    path: byPath,
    size: (a, b) => (b.size ?? -1) - (a.size ?? -1) || byPath(a, b),
    mtime: (a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || byPath(a, b),
  }[sort] || byPath;

  rows.sort((a, b) => {
    if (dirsFirst && a.dir !== b.dir) {
      return a.dir ? -1 : 1;
    }
    return compare(a, b);
  });

  return {
    rows,
    count: Number.isFinite(listing && listing.count) ? listing.count : rows.length,
    truncated: Boolean(listing && listing.truncated),
  };
}

/** Component-wise path order, so `a/b` sorts before `a/b/c`. */
function comparePaths(a, b) {
  const as = a.split("/");
  const bs = b.split("/");
  const depth = Math.min(as.length, bs.length);
  for (let i = 0; i < depth; i += 1) {
    if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

/**
 * A `**\/*.bf`-ish glob, as the `files` card's filter box uses it.
 * `**` crosses directories, `*` does not.  A plain substring also matches, so
 * typing `view` finds `core/src/view.c` without knowing the syntax.
 */
export function matchesFilter(path, filter) {
  const want = typeof filter === "string" ? filter.trim() : "";
  if (want === "" || want === "**/*") {
    return true;
  }
  // `**` must be rewritten before `*`; the placeholder keeps the single-`*`
  // pass from eating the `(?:.*/)?` that `**/` degrades into.
  const DOTSTAR = "\u0000";
  const escaped = want
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DOTSTAR)
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(DOTSTAR)
    .join("(?:.*/)?");
  // A pattern that names directories is anchored at the workspace root, so
  // `core/src/*.c` does not also match `vendor/core/src/x.c`; a bare word stays
  // a substring search, because guessing intent there would be worse.
  const anchored = want.includes("/") ? escaped : `(?:.*/)?${escaped}`;
  try {
    return new RegExp(`^${anchored}$`).test(path) || path.includes(want);
  } catch {
    return path.includes(want);
  }
}

/* ------------------------------------------------------------------ */
/* searching the workspace                                             */
/* ------------------------------------------------------------------ */

/*
 * Finding text is the one thing a board of cards cannot do by looking: an
 * editor card shows one file, and there is no tree to grep from.  The three
 * helpers below are pure, so the arithmetic -- which line, which column, how
 * much of a long line to show, when to stop -- is checked without a browser or
 * a workspace.  The card does the reading and the DOM, and nothing else.
 */

/** How many files one search reads before it stops and says so. */
export const SEARCH_MAX_FILES = 200;

/** How many hits one search reports. */
export const SEARCH_MAX_HITS = 200;

/** How many hits one file may contribute. */
export const SEARCH_MAX_PER_FILE = 50;

/** Bigger files are skipped: reading a 40 MB log to find a word is not a feature. */
export const SEARCH_MAX_BYTES = 512 * 1024;

/**
 * Every literal hit of `query` in one text, each with the line and column it
 * sits on.
 *
 * Literal, and case-insensitive unless asked otherwise: the same matching the
 * editor's find bar does, so one query behaves the same in both places.
 * `start`/`end` are string indices, like every other offset in this shell.
 *
 * @returns {Array<{line: number, column: number, start: number, end: number, text: string}>}
 */
export function searchInText(text, query, options = {}) {
  const { caseSensitive = false, maxPerFile = SEARCH_MAX_PER_FILE } = options;
  if (typeof text !== "string" || typeof query !== "string" || query === "") {
    return [];
  }
  const out = [];
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const hit of findMatches(text, query, { caseSensitive })) {
    while (scanned < hit.start) {
      if (text[scanned] === "\n") {
        line += 1;
        lineStart = scanned + 1;
      }
      scanned += 1;
    }
    out.push({
      line,
      column: hit.start - lineStart + 1,
      start: hit.start,
      end: hit.end,
      text: lineText(text, hit.start),
    });
    if (out.length >= maxPerFile) {
      break;
    }
  }
  return out;
}

/** The line `index` sits on, without its line ending. */
function lineText(text, index) {
  const from = text.lastIndexOf("\n", Math.max(0, index) - 1) + 1;
  const to = text.indexOf("\n", Math.max(0, index));
  return text.slice(from, to === -1 ? text.length : to).replace(/\r$/, "");
}

/**
 * A window of one line around a hit, in three pieces so the caller can wrap the
 * middle one without searching for it again.  A cut edge is marked with `…`: a
 * line that looks complete but starts mid-token is worse than a trimmed one.
 *
 * @returns {{leading: string, hit: string, trailing: string}}
 */
export function searchExcerpt(line, hitStart, hitEnd, options = {}) {
  const { context = 40 } = options;
  const text = typeof line === "string" ? line : "";
  const from = Math.max(0, hitStart - context);
  const to = Math.min(text.length, hitEnd + context);
  return {
    leading: `${from > 0 ? "…" : ""}${text.slice(from, hitStart)}`,
    hit: text.slice(hitStart, hitEnd),
    trailing: `${text.slice(hitEnd, to)}${to < text.length ? "…" : ""}`,
  };
}

/**
 * Search many files and put the rows in the order a person reads them: by path,
 * then down the file.
 *
 * `files` is `[{path, text}]` -- whatever the caller managed to read.  The
 * budget lives here rather than in the caller, so "truncated" means the same
 * thing in the card, in the tests and in the status line.
 *
 * @returns {{hits: Array<object>, searched: number, matchedFiles: number, truncated: boolean}}
 */
export function searchFiles(files, query, options = {}) {
  const {
    caseSensitive = false,
    maxHits = SEARCH_MAX_HITS,
    maxPerFile = SEARCH_MAX_PER_FILE,
  } = options;
  const hits = [];
  const matched = new Set();
  let searched = 0;
  let truncated = false;
  let perFileCapped = false;
  for (const file of Array.isArray(files) ? files : []) {
    if (file === null || typeof file !== "object"
      || typeof file.path !== "string" || typeof file.text !== "string") {
      continue;
    }
    searched += 1;
    const found = searchInText(file.text, query, { caseSensitive, maxPerFile });
    if (found.length === 0) {
      continue;
    }
    if (found.length >= maxPerFile) {
      // The file may have more: a full page is the only hint a cap gives.
      perFileCapped = true;
    }
    matched.add(file.path);
    for (const item of found) {
      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
      hits.push({ path: file.path, ...item });
    }
    if (truncated) {
      break;
    }
  }
  hits.sort((a, b) => comparePaths(a.path, b.path) || a.start - b.start);
  return { hits, searched, matchedFiles: matched.size, truncated, perFileCapped };
}

/* ------------------------------------------------------------------ */
/* the project view                                                    */
/* ------------------------------------------------------------------ */

/*
 * What the project view can and cannot show.
 *
 * `workspace.list` is the only source of file names here, and the kernel skips
 * whole directories by name while it walks (`IGNORED_DIRS` in
 * `core/src/wksp.c`: `.git`, `.seide`, `build`, `node_modules`, ...).  The call
 * has no flag to ask for them, so this side cannot un-hide them -- a panel that
 * filtered them itself would be counting rows that never arrive.
 *
 * So the project view does not filter: it reports what the kernel left out,
 * read from `workspace.info.ignored` (the kernel's own table, so the two can
 * never disagree), and says so when a filter matches nothing.  The `files` card
 * shows the same set for the same reason.
 */

/** `a/b/c.txt` -> `a/b`; a file at the workspace root -> `""`. */
export function dirNameOf(path) {
  const rel = typeof path === "string" ? path.replace(/\\/g, "/") : "";
  const at = rel.lastIndexOf("/");
  return at <= 0 ? "" : rel.slice(0, at);
}

/**
 * Fold `workspace.list` plus the files the board has open into the project
 * view: one row per file, grouped by folder, each carrying its open/dirty
 * state.  Pure -- no DOM, no filesystem -- so `selftest.mjs` can drive it.
 *
 * The project is "the files of this workspace", and the panel exists to make
 * editing many of them convenient: a row that is open jumps to its card, a row
 * that is not opens one, and an editor card whose file is gone from disk is
 * reported as `missing` rather than silently kept.
 *
 * @param {object} listing  the `workspace.list` payload (may be absent)
 * @param {{open?: Array<{id?:string,path?:string,dirty?:boolean}>,
 *          filter?: string, now?: number}} [options]
 * @returns {{groups: Array<{folder:string,label:string,rows:object[]}>,
 *            openRows: object[], missingRows: object[], counts: object}}
 */
export function projectRows(listing, options = {}) {
  const {
    open = [],
    filter = "**/*",
    now = Math.floor(Date.now() / 1000),
  } = options;

  // The open set first: it marks rows and it is what "missing" is built from.
  const openByPath = new Map();
  const openList = [];
  for (const item of Array.isArray(open) ? open : []) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const path = typeof item.path === "string" ? item.path.replace(/\\/g, "/") : "";
    if (path === "") {
      continue;
    }
    const record = {
      id: typeof item.id === "string" ? item.id : "",
      path,
      name: path.split("/").pop() || path,
      folder: dirNameOf(path),
      dirty: item.dirty === true,
    };
    openList.push(record);
    if (!openByPath.has(path)) {
      openByPath.set(path, record);
    }
  }

  const { rows } = formatListing(listing, { now });
  const onDisk = new Set();
  const byFolder = new Map();
  let files = 0;
  let dirs = 0;

  for (const row of rows) {
    if (row.dir) {
      dirs += 1;
      continue; // folders are the grouping, not a row of their own
    }
    files += 1;
    onDisk.add(row.path);

    const seen = openByPath.get(row.path);
    const entry = {
      path: row.path,
      name: row.name,
      folder: dirNameOf(row.path),
      sizeText: row.sizeText,
      ageText: row.ageText,
      open: seen !== undefined,
      dirty: seen !== undefined && seen.dirty,
      cardId: seen === undefined ? null : seen.id,
    };

    if (!matchesFilter(entry.path, filter)) {
      continue;
    }
    if (!byFolder.has(entry.folder)) {
      byFolder.set(entry.folder, []);
    }
    byFolder.get(entry.folder).push(entry);
  }

  const groups = [];
  for (const folder of [...byFolder.keys()].sort(comparePaths)) {
    const groupRows = byFolder.get(folder);
    groupRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    groups.push({
      folder,
      label: folder === "" ? "(root)" : `${folder}/`,
      rows: groupRows,
    });
  }

  // An open editor whose path is not in the listing is a file that moved or
  // was deleted while its card stayed on the board.  On a truncated listing
  // that judgement is not safe, which the counts record as `complete`.
  const openRows = [];
  const missingRows = [];
  for (const record of openList.slice().sort((a, b) => comparePaths(a.path, b.path))) {
    const summary = { ...record, present: onDisk.has(record.path) };
    openRows.push(summary);
    if (!summary.present) {
      missingRows.push(summary);
    }
  }

  let shown = 0;
  for (const group of groups) {
    shown += group.rows.length;
  }

  return {
    groups,
    openRows,
    missingRows,
    counts: {
      files,
      dirs,
      shown,
      groups: groups.length,
      open: openList.length,
      dirty: openList.filter((row) => row.dirty).length,
      missing: missingRows.length,
      truncated: Boolean(listing && listing.truncated),
      complete: !(listing && listing.truncated),
    },
  };
}

/** The one-line summary of a project view, e.g. `128 files · 6 open`. */
export function projectSummary(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const parts = [`${c.files || 0} files`];
  if (c.dirs) {
    parts.push(`${c.dirs} folders`);
  }
  parts.push(`${c.open || 0} open`);
  if (c.dirty) {
    parts.push(`${c.dirty} unsaved`);
  }
  if (c.missing) {
    parts.push(`${c.missing} missing`);
  }
  if (c.truncated) {
    parts.push("listing truncated");
  }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

/** Split a command line on whitespace, honouring double quotes. */
export function parseCommandLine(line) {
  const text = typeof line === "string" ? line : "";
  const tokens = [];
  let current = "";
  let started = false;
  let quote = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quote = !quote;
      started = true;
      continue;
    }
    if (!quote && (ch === " " || ch === "\t")) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** `in`/`out` are relative; a number (or `50%`) is absolute. `null` = unusable. */
export function parseZoomArgument(arg, current = 1) {
  const word = typeof arg === "string" ? arg.trim().toLowerCase() : "";
  if (word === "") {
    return null;
  }
  if (word === "in") {
    return current * 1.25;
  }
  if (word === "out") {
    return current / 1.25;
  }
  if (word === "reset") {
    return 1;
  }
  const value = Number(word.endsWith("%") ? word.slice(0, -1) / 100 : word);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* run output                                                          */
/* ------------------------------------------------------------------ */

/**
 * A bounded text accumulator for `proc.output`.
 *
 * Runs can emit unbounded output; keeping all of it would eventually freeze the
 * window, so once the cap is passed the *head* is dropped -- both in characters
 * and in whole lines -- and a marker says how much went.  Recent output is what
 * a build log is read for, which is why it is the tail that survives.
 */
export class OutputBuffer {
  constructor(options = {}) {
    const { maxChars = 200000, maxLines = 2000 } = options;
    this.maxChars = maxChars;
    this.maxLines = maxLines;
    this.text = "";
    this.dropped = 0;
    this.droppedLines = 0;
  }

  append(chunk) {
    if (typeof chunk !== "string" || chunk === "") {
      return;
    }
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      const cut = this.text.length - this.maxChars;
      this.text = this.text.slice(cut);
      this.dropped += cut;
    }
    // Cap whole lines too: a long run of short lines would otherwise grow the
    // DOM without bound even though the character cap was never reached.
    //
    // The splitter must be the one `lines()` renders with.  Counting with
    // plain "\n" while rendering with /\r?\n/ made the cap and the view
    // disagree on every CRLF line -- which is every line a Windows command
    // writes -- so the buffer kept one line more than it claimed to.
    const lines = this.text.split(/\r?\n/);
    if (lines.length > this.maxLines) {
      const cut = lines.length - this.maxLines;
      this.droppedLines += cut;
      // Rejoining with "\n" is deliberate: the retained tail is normalised to
      // LF so that slicing it again is idempotent.
      this.text = lines.slice(cut).join("\n");
    }
  }

  /** The tail of the buffer as whole lines, oldest first. */
  lines() {
    const all = this.text.split(/\r?\n/);
    const head = this.dropped > 0 || this.droppedLines > 0
      ? [`[... ${this.dropped} earlier characters, ${this.droppedLines} earlier lines dropped ...]`]
      : [];
    return head.concat(all);
  }

  clear() {
    this.text = "";
    this.dropped = 0;
    this.droppedLines = 0;
  }

  get length() {
    return this.text.length;
  }
}

/** `proc.exit` -> the short suffix the runner card shows. */
export function formatExit(code) {
  if (code === null || code === undefined) {
    return "running";
  }
  const n = Number(code);
  if (!Number.isFinite(n)) {
    return "exited";
  }
  if (n === 0) {
    return "exit 0";
  }
  return n < 0 ? `killed (${n})` : `exit ${n}`;
}

/* ------------------------------------------------------------------ */
/* the card-kind hook                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every registered kind, in registration order, keyed by `card.kind`.
 *
 * This map is the single extension point of the board's visual vocabulary.
 * It is a hook, not a plugin system: there is no loading, no sandbox, no
 * manifest, no version negotiation and no discovery.  A fork registers its
 * kinds in this file, or in a file it adds next to this one.
 */
const KIND_REGISTRY = new Map();

/**
 * The shape `registerCardKind` accepts.  Documentation, not enforcement --
 * but it is the exact list `selftest.mjs` holds new kinds to.
 *
 * A kind is one object:
 *
 *   kind      string   must equal `card.kind` on the wire
 *   title     string   human name, used by the board's own UI
 *   describe  card => string
 *                      one line for the header; may not throw
 *   render    (card, ctx) => {el, handle, destroy}
 *                      the only required member
 *   create    () => object
 *                      the extra fields a *new* card of this kind starts with
 *
 * `render` gets `ctx = {client, app}` and owns its own DOM.  It reads and
 * writes whatever fields it likes on `card`, which for `sheet` is a nested
 * object rather than a string: nothing in the board, the protocol or the
 * kernel assumes a card's state is text.
 */
export const CARD_KIND_CONTRACT = Object.freeze({
  required: Object.freeze(["kind", "render"]),
  optional: Object.freeze(["title", "describe", "create"]),
});

/**
 * Register one card kind.  Returns the frozen spec, so the caller can hold on
 * to it and see exactly what the registry kept.
 *
 * Re-registering an existing kind throws unless `replace: true` is passed, so
 * a fork that means to override a built-in has to say so.
 */
export function registerCardKind(spec) {
  if (spec === null || typeof spec !== "object") {
    throw new TypeError("registerCardKind: spec must be an object");
  }
  const { kind } = spec;
  if (typeof kind !== "string" || kind === "") {
    throw new TypeError("registerCardKind: spec.kind must be a non-empty string");
  }
  if (typeof spec.render !== "function") {
    throw new TypeError(`registerCardKind: ${kind}.render must be a function`);
  }
  if (KIND_REGISTRY.has(kind) && spec.replace !== true) {
    throw new Error(`registerCardKind: card kind ${JSON.stringify(kind)} is already registered`);
  }
  const frozen = Object.freeze({
    title: kind,
    describe: (card) => `${kind} ${card.id}`,
    create: () => ({}),
    ...spec,
  });
  KIND_REGISTRY.set(kind, frozen);
  return frozen;
}

/** The spec registered for `kind`, or null. */
export function cardKind(kind) {
  return KIND_REGISTRY.get(kind) ?? null;
}

/** Every registered kind name, in registration order. */
export function knownCardKinds() {
  return [...KIND_REGISTRY.keys()];
}

/** One-line description of a card, used by the board header. */
export function describeCard(card) {
  if (card === null || typeof card !== "object") {
    return "no card selected";
  }
  const kind = typeof card.kind === "string" ? card.kind : "?";
  const spec = KIND_REGISTRY.get(kind);
  if (spec !== undefined) {
    try {
      const line = spec.describe(card);
      if (typeof line === "string" && line !== "") {
        return line;
      }
    } catch (err) {
      /* A kind whose describe() throws must not take the whole header down. */
      return `${kind} ${card.id} (describe threw)`;
    }
  }
  return `${kind} ${card.id}`;
}

/** The command line's `help` text. Kept here so README and UI agree. */
export const COMMAND_HELP = [
  "open <path>              open a file in a new editor card",
  "note <text>              drop a note card",
  "sheet [title]            drop a structured-data card (typed cells, not text)",
  "run <cmd>                start a command in a runner card",
  "files [glob]             open the file list card",
  "find <text>              search the workspace (or re-point the search card)",
  "group [title]            frame the selection (or drop an empty frame)",
  "ungroup [id...]          remove frames; the cards they held stay",
  "project [glob]           open the project panel (the workspace as one project)",
  "link <from> <to> [label] connect two cards",
  "unlink <linkId>          remove a connection",
  "zoom <n> | in | out | reset",
  "focus <id>               select and centre a card",
  "select <id...> | all | none",
  "delete <id>              remove a card (no id: everything selected)",
  "save                     write the board to .seide/board.json",
  "undo                     take back the last board edit (Ctrl+Z)",
  "redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)",
  "mode board | classic     the board, or the same cards as sidebar + tabs + code area",
];

/* ------------------------------------------------------------------ */
/* the sheet model (pure)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A sheet is structured state, not source text: named columns with types, and
 * rows holding one value per column.  It is the prototype's proof that the
 * board carries arbitrary card payloads -- the kernel stores it verbatim, the
 * board's normaliser clones it verbatim, and the protocol never sees it as a
 * string.  See `docs/SURFACES.md`.
 */
export const SHEET_TYPES = Object.freeze(["text", "number", "bool", "choice"]);

/** Cell values that survive a trip through JSON and back. */
export function coerceSheetValue(type, value) {
  switch (type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      const n = typeof value === "string" ? Number(value.trim()) : NaN;
      return Number.isFinite(n) ? n : 0;
    }
    case "bool":
      return value === true || value === "true" || value === 1;
    default: {
      if (value === null || value === undefined) {
        return "";
      }
      return typeof value === "string" ? value : String(value);
    }
  }
}

/**
 * A fresh one-by-one sheet.
 *
 * `normaliseSheet` treats zero rows as legal (a header-only grid is a real
 * thing to want), but a *new* card has to open with somewhere to type, so the
 * starting point is one column and one row.
 */
export function emptySheet() {
  return normaliseSheet({
    columns: [{ id: "column1", title: "column1", type: "text" }],
    rows: [{ id: "row1", cells: { column1: "" } }],
  });
}

function sheetId(prefix, taken) {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

/**
 * Repair anything into a usable sheet.  Never throws: a card whose payload was
 * written by an older or a buggier build still has to render.
 */
export function normaliseSheet(doc) {
  const input = doc !== null && typeof doc === "object" ? doc : {};
  const rawColumns = Array.isArray(input.columns) ? input.columns : [];
  const columns = [];
  const columnIds = new Set();
  for (const raw of rawColumns) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : sheetId("column", columnIds);
    if (columnIds.has(id)) {
      id = sheetId(id, columnIds);
    }
    const type = SHEET_TYPES.includes(raw.type) ? raw.type : "text";
    const column = { id, title: typeof raw.title === "string" && raw.title !== "" ? raw.title : id, type };
    if (type === "choice") {
      column.options = Array.isArray(raw.options)
        ? raw.options.filter((o) => typeof o === "string")
        : [];
    }
    columnIds.add(id);
    columns.push(column);
  }
  if (columns.length === 0) {
    columns.push({ id: "column1", title: "column1", type: "text" });
  }

  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const rows = [];
  const rowIds = new Set();
  for (const raw of rawRows) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : sheetId("row", rowIds);
    if (rowIds.has(id)) {
      id = sheetId(id, rowIds);
    }
    const given = raw.cells !== null && typeof raw.cells === "object" ? raw.cells : {};
    const cells = {};
    for (const column of columns) {
      cells[column.id] = coerceSheetValue(column.type, given[column.id]);
    }
    rowIds.add(id);
    rows.push({ id, cells });
  }
  return { columns, rows };
}

/**
 * Write a normalised sheet back into the caller's object.
 *
 * Every mutator below works on a normalised copy and then lands the result
 * here, so `card.doc` keeps its identity across edits -- which is what lets the
 * board's dirty flag and `serialize()` see the change without re-registering
 * the card.
 */
function replaceSheet(doc, sheet) {
  doc.columns = sheet.columns;
  doc.rows = sheet.rows;
  return doc;
}

/**
 * One cell's value out of a sheet that is already normalised, or "" when either
 * end of the lookup is missing.
 *
 * The paint loop holds one normalised sheet for the whole grid and must not
 * normalise once per cell, so the lookup is split out of `sheetCell` here.
 */
function sheetCellOf(sheet, rowId, columnId) {
  const row = sheet.rows.find((r) => r.id === rowId);
  if (row === undefined) {
    return "";
  }
  const column = sheet.columns.find((c) => c.id === columnId);
  if (column === undefined) {
    return "";
  }
  return coerceSheetValue(column.type, row.cells[columnId]);
}

/** One cell's value, or "" when either end of the lookup is missing. */
export function sheetCell(doc, rowId, columnId) {
  return sheetCellOf(normaliseSheet(doc), rowId, columnId);
}

/**
 * The one write path for a cell: normalise the document once, hand the cell's
 * current value to `compute`, coerce what comes back by the column's type, and
 * land the copy in `doc` through `replaceSheet`.  Returns the value that was
 * stored, or undefined when the cell is gone.
 *
 * It returns the stored value rather than a flag because a handler that has to
 * show the coerced value ("  2  " -> "2") would otherwise read the cell back
 * through `sheetCell`, normalising the whole document a second time.
 */
function applySheetCell(doc, rowId, columnId, compute) {
  const sheet = normaliseSheet(doc);
  const row = sheet.rows.find((r) => r.id === rowId);
  const column = sheet.columns.find((c) => c.id === columnId);
  if (row === undefined || column === undefined) {
    return undefined;
  }
  const stored = coerceSheetValue(column.type, compute(coerceSheetValue(column.type, row.cells[columnId])));
  row.cells[columnId] = stored;
  replaceSheet(doc, sheet);
  return stored;
}

/**
 * Set one cell, coercing by the column's type so a number column stays numeric
 * on the wire.  Mutates `doc` in place and returns true when the cell existed.
 */
export function setSheetCell(doc, rowId, columnId, value) {
  return applySheetCell(doc, rowId, columnId, () => value) !== undefined;
}

/** Append a row (or insert at `index`), filling every column with its zero value. */
export function addSheetRow(doc, index = -1) {
  const sheet = normaliseSheet(doc);
  const id = sheetId("row", new Set(sheet.rows.map((r) => r.id)));
  const cells = {};
  for (const column of sheet.columns) {
    cells[column.id] = coerceSheetValue(column.type, "");
  }
  const row = { id, cells };
  const at = index < 0 || index >= sheet.rows.length ? sheet.rows.length : index;
  sheet.rows.splice(at, 0, row);
  replaceSheet(doc, sheet);
  return row;
}

/** Remove a row.  The last row may go: an empty sheet is a legal sheet. */
export function removeSheetRow(doc, rowId) {
  const sheet = normaliseSheet(doc);
  const before = sheet.rows.length;
  sheet.rows = sheet.rows.filter((r) => r.id !== rowId);
  const removed = sheet.rows.length !== before;
  if (removed) {
    replaceSheet(doc, sheet);
  }
  return removed;
}

/**
 * Append a column (or insert at `index`).  Every existing row gains a cell,
 * because a row is a map keyed by column id and a half-populated row would
 * make `sheetCell` and the renderer disagree.
 */
export function addSheetColumn(doc, type = "text", index = -1) {
  const sheet = normaliseSheet(doc);
  const id = sheetId("column", new Set(sheet.columns.map((c) => c.id)));
  const column = { id, title: id, type: SHEET_TYPES.includes(type) ? type : "text" };
  if (column.type === "choice") {
    column.options = ["one", "two", "three"];
  }
  const at = index < 0 || index >= sheet.columns.length ? sheet.columns.length : index;
  sheet.columns.splice(at, 0, column);
  for (const row of sheet.rows) {
    row.cells[id] = coerceSheetValue(column.type, "");
  }
  replaceSheet(doc, sheet);
  return column;
}

/** Remove a column and every cell under it.  The last column may not go. */
export function removeSheetColumn(doc, columnId) {
  const sheet = normaliseSheet(doc);
  if (sheet.columns.length <= 1) {
    return false;
  }
  const before = sheet.columns.length;
  sheet.columns = sheet.columns.filter((c) => c.id !== columnId);
  if (sheet.columns.length === before) {
    return false;
  }
  for (const row of sheet.rows) {
    delete row.cells[columnId];
  }
  replaceSheet(doc, sheet);
  return true;
}

/**
 * Write a column's header fields, resolving the column in the LIVE document by
 * id.
 *
 * `columnId` is the only column handle a caller may keep across a write: every
 * write lands a fresh set of column objects in `doc` (`replaceSheet`), so a DOM
 * listener that closed over the column object its paint was handed writes the
 * rename into a sheet the card no longer holds, and the next repaint shows the
 * old title again.
 *
 * `patch.title` and `patch.type` are what the header edits.  A type change
 * re-normalises, because every cell under the column takes the new type and
 * `normaliseSheet` is where that coercion lives.
 *
 * Returns the normalised sheet it wrote back, so a caller can refresh whatever
 * it derives from the sheet without normalising a second time, or null when no
 * column has that id.
 */
export function updateSheetColumn(doc, columnId, patch) {
  let sheet = normaliseSheet(doc);
  const column = sheet.columns.find((c) => c.id === columnId);
  if (column === undefined) {
    return null;
  }
  const input = patch !== null && typeof patch === "object" ? patch : {};
  if (typeof input.title === "string") {
    column.title = input.title;
  }
  if (SHEET_TYPES.includes(input.type) && input.type !== column.type) {
    column.type = input.type;
    if (column.type === "choice") {
      if (!Array.isArray(column.options)) {
        column.options = ["one", "two", "three"];
      }
    } else {
      delete column.options;
    }
    sheet = normaliseSheet(sheet);
  }
  replaceSheet(doc, sheet);
  return sheet;
}

/** "3 rows x 4 columns" out of an already-normalised sheet, singularised. */
function sheetSummaryOf(sheet) {
  const r = sheet.rows.length;
  const c = sheet.columns.length;
  return `${r} row${r === 1 ? "" : "s"} x ${c} column${c === 1 ? "" : "s"}`;
}

/** "3 rows x 4 columns", singularised. */
export function sheetSummary(doc) {
  return sheetSummaryOf(normaliseSheet(doc));
}

/**
 * The sheet as tab-separated text: a header line, then one line per row.
 * This is how structured state leaves the card -- hand it to a runner card,
 * paste it into an editor card, or write it to a file.
 */
export function sheetToTSV(doc) {
  const sheet = normaliseSheet(doc);
  const escape = (value) => String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines = [sheet.columns.map((c) => escape(c.title)).join("\t")];
  for (const row of sheet.rows) {
    lines.push(sheet.columns.map((c) => escape(row.cells[c.id])).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Grid navigation: the next `{row, column}` index from `{row, column}` moved by
 * `dRow`/`dColumn`, clamped at the edges.  Returns null on an empty sheet.
 */
export function nextSheetSelection(doc, selection, dRow, dColumn) {
  const sheet = normaliseSheet(doc);
  if (sheet.rows.length === 0 || sheet.columns.length === 0) {
    return null;
  }
  const rowCount = sheet.rows.length;
  const columnCount = sheet.columns.length;
  let row = selection === null || typeof selection !== "object" ? 0 : Number(selection.row) || 0;
  let column = selection === null || typeof selection !== "object" ? 0 : Number(selection.column) || 0;
  row = Math.min(rowCount - 1, Math.max(0, row + (Number(dRow) || 0)));
  column = Math.min(columnCount - 1, Math.max(0, column + (Number(dColumn) || 0)));
  return { row, column };
}

/* ------------------------------------------------------------------ */
/* DOM                                                                    */
/* ------------------------------------------------------------------ */

/** Create an element with class names, text, attributes and children. */
function h(tag, className, options = {}) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (options.text !== undefined) {
    el.textContent = options.text;
  }
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) {
      el.setAttribute(key, options.attrs[key]);
    }
  }
  if (options.children) {
    for (const child of options.children) {
      el.append(child);
    }
  }
  return el;
}

/**
 * Wrap a card body in the shell every kind shares: a title bar (the drag
 * handle), the body, and a corner grip (the resize handle).  `main.mjs` binds
 * its pointer gestures to `[data-role="card-title"]` and `[data-role="grip"]`.
 */
function cardShell(card, body, options = {}) {
  const title = h("div", "card-title", { attrs: { "data-role": "card-title" } });
  title.append(h("span", "card-kind", { text: card.kind }));
  const label = h("span", "card-label", { attrs: { "data-role": "card-label" } });
  title.append(label);
  const tools = h("span", "card-tools", { attrs: { "data-role": "card-tools" } });
  title.append(tools);

  const grip = h("div", "card-grip", { attrs: { "data-role": "grip", title: "drag to resize" } });
  const el = h("div", `card card-${card.kind}`, {
    attrs: { "data-card-id": card.id },
    children: [title, body, grip],
  });
  if (options.accent) {
    el.classList.add("is-accent");
  }
  return { el, title, label, tools };
}

/**
 * Fill a `<pre>` with one text node or `<span>` per segment.
 *
 * `hits` (from `findMatches`) widen each segment with a flag, and every matched
 * piece is wrapped in a `<mark>` so it shows through the transparent textarea
 * above.  `current` is the match the find bar is standing on.
 */
function paintTokens(pre, text, tokens, hits = [], current = -1) {
  const segments = markHits(applyTokenSpans(text, tokens), hits, current);
  pre.textContent = "";
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const chunk = text.slice(seg.start, seg.end);
    let node;
    if (seg.kind === "plain") {
      node = document.createTextNode(chunk);
    } else {
      node = h("span", `tok-${seg.kind}`, { text: chunk });
    }
    if (seg.hit) {
      node = h("mark", seg.current ? "ed-hit is-current" : "ed-hit", {
        attrs: { "data-role": "find-hit" },
        children: [node],
      });
    }
    frag.append(node);
  }
  pre.append(frag);
  return segments.length;
}

function makeStatus() {
  return h("div", "card-status", { attrs: { "data-role": "card-status" } });
}

/**
 * Build one card.
 *
 * @param {object} card  the board card; its extra fields are the card's state
 * @param {object} ctx   `{client, app}` -- the only way out of a card
 * @returns {{el: HTMLElement, handle: object, destroy: Function}}
 */
export function renderCard(card, ctx) {
  const spec = card !== null && typeof card === "object" && !Array.isArray(card)
    ? KIND_REGISTRY.get(card.kind)
    : undefined;
  return spec === undefined ? renderUnknown(card) : spec.render(card, ctx);
}

/**
 * What to show for a board entry that has no renderer: a kind this build does
 * not know, or -- because board.json is user-editable -- an entry that is not a
 * card at all.
 *
 * Pure and exported on purpose.  This is the one render path that must never
 * throw: one malformed entry in the file must not take the whole canvas down,
 * and its message is therefore worth checking without a browser.
 *
 * @param {object|null|undefined} card
 * @returns {{id: string, kind: string, label: string, message: string}}
 */
export function unknownCardPlaceholder(card) {
  const known = `Known kinds: ${knownCardKinds().join(", ")}.`;
  if (card === null || card === undefined) {
    return {
      id: "",
      kind: "(none)",
      label: "(missing)",
      message: "This board entry is empty (null), so there is nothing to render. "
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  if (typeof card !== "object" || Array.isArray(card)) {
    return {
      id: "",
      kind: "(not a card)",
      label: "(malformed)",
      message: `This board entry is ${JSON.stringify(card)}, not a card object. `
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  const kind = typeof card.kind === "string" && card.kind !== "" ? card.kind : "(no kind)";
  return {
    id: typeof card.id === "string" ? card.id : "",
    kind,
    label: "(unknown)",
    message: `No renderer for card kind ${JSON.stringify(card.kind)}. `
      + "The card is preserved in board.json; register a kind in cards.mjs."
      + `  ${known}`,
  };
}

/** Unknown kinds are preserved and shown, never silently deleted. */
function renderUnknown(card) {
  const notice = unknownCardPlaceholder(card);
  const body = h("div", "card-body card-body-unknown", {
    children: [h("p", "card-message", { text: notice.message })],
  });
  // `cardShell` reads `id`/`kind` off its argument, so it gets the repaired
  // values rather than the malformed entry: a null still has to produce a card.
  const shell = cardShell({ id: notice.id, kind: notice.kind }, body);
  shell.label.textContent = notice.label;
  return {
    el: shell.el,
    handle: { kind: notice.kind, focus() {} },
    destroy() {},
  };
}

/* -------------------- editing text -------------------- */

/** One indent step: four spaces, the step the tree's C and JS already use. */
export const INDENT_UNIT = "    ";

/** A line ending in one of these opens a block, so the next line steps in. */
const BLOCK_OPENERS = "{([";

/** Clamp to a real position in `text`, and never return an inverted range. */
function clampRange(text, start, end) {
  const limit = text.length;
  const from = Math.max(0, Math.min(limit, Number.isFinite(start) ? Math.trunc(start) : 0));
  const to = Math.max(from, Math.min(limit, Number.isFinite(end) ? Math.trunc(end) : from));
  return { from, to };
}

/**
 * Indent or outdent the lines the selection touches, and say what to select
 * afterwards.
 *
 * Pure, so `selftest.mjs` can check every branch without a browser.  A caret
 * with nothing selected gets one step inserted in place; anything else is
 * line-wise, which is what makes Tab repeatable while a region stays selected.
 * Outdenting removes one tab or up to one step of leading spaces, never a
 * character that was not indentation.
 *
 * @param {string} text
 * @param {number} start  selection start (a string index, not a byte offset)
 * @param {number} end    selection end
 * @param {{unit?: string, outdent?: boolean}} [options]
 * @returns {{text: string, selectionStart: number, selectionEnd: number}}
 */
export function indentSelection(text, start, end, options = {}) {
  const { unit = INDENT_UNIT, outdent = false } = options;
  const { from, to } = clampRange(text, start, end);
  if (!outdent && from === to) {
    return {
      text: text.slice(0, from) + unit + text.slice(from),
      selectionStart: from + unit.length,
      selectionEnd: from + unit.length,
    };
  }
  const regionStart = text.lastIndexOf("\n", from - 1) + 1;
  // A selection that stops just past a newline does not reach into the next
  // line, so that line is left alone.
  const tail = to > from && text[to - 1] === "\n" ? to - 1 : to;
  const newline = text.indexOf("\n", tail);
  const regionEnd = newline === -1 ? text.length : newline;
  const lines = text.slice(regionStart, regionEnd).split("\n").map((line) => {
    if (!outdent) {
      return unit + line;
    }
    if (line.startsWith("\t")) {
      return line.slice(1);
    }
    let cut = 0;
    while (cut < unit.length && line[cut] === " ") {
      cut += 1;
    }
    return line.slice(cut);
  });
  const body = lines.join("\n");
  return {
    text: text.slice(0, regionStart) + body + text.slice(regionEnd),
    selectionStart: regionStart,
    selectionEnd: regionStart + body.length,
  };
}

/**
 * What to insert after a newline: the line's own indentation, plus one step
 * when that line opens a block.  `lineBefore` is the text between the start of
 * the line and the caret.
 *
 * Deliberately one-way: a closing brace does not step back out, because the
 * guess would be wrong as often as it is right.
 */
export function indentAfterEnter(lineBefore, options = {}) {
  const { unit = INDENT_UNIT } = options;
  const match = /^[ \t]*/.exec(lineBefore);
  const indent = match === null ? "" : match[0];
  const trimmed = lineBefore.replace(/\s+$/, "");
  if (trimmed === "" || !BLOCK_OPENERS.includes(trimmed.slice(-1))) {
    return indent;
  }
  return indent + unit;
}

/**
 * Every literal occurrence of `query`, left to right, never overlapping.
 *
 * Case-insensitive unless asked otherwise -- and case-sensitive anyway when
 * folding would change the string's length, because the offsets this returns
 * index the original text and must stay valid.
 *
 * @returns {Array<{start: number, end: number}>}
 */
export function findMatches(text, query, options = {}) {
  const { caseSensitive = false } = options;
  if (typeof query !== "string" || query === "" || typeof text !== "string") {
    return [];
  }
  const folded = text.toLowerCase();
  const foldable = folded.length === text.length && query.toLowerCase().length === query.length;
  const useCase = caseSensitive || !foldable;
  const haystack = useCase ? text : folded;
  const needle = useCase ? query : query.toLowerCase();
  const hits = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    hits.push({ start: at, end: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** Replace one match in place; `hit` comes from `findMatches`. */
export function replaceMatchAt(text, hit, replacement) {
  if (hit === null || hit === undefined || hit.start < 0 || hit.end > text.length) {
    return text;
  }
  return text.slice(0, hit.start) + replacement + text.slice(hit.end);
}

/** Replace every match at once, and report how many there were. */
export function replaceAllMatches(text, query, replacement, options = {}) {
  const hits = findMatches(text, query, options);
  if (hits.length === 0) {
    return { text, count: 0 };
  }
  let out = "";
  let at = 0;
  for (const hit of hits) {
    out += text.slice(at, hit.start) + replacement;
    at = hit.end;
  }
  return { text: out + text.slice(at), count: hits.length };
}

/**
 * Split coloured segments so each piece carries its own find-hit flag, which is
 * how a match stays visible behind the transparent textarea while the caret is
 * somewhere else entirely.
 *
 * `hits` must be ascending and non-overlapping, as `findMatches` returns them.
 * Pure, so the selftest can check the seam cases.
 *
 * @param {Array<{start: number, end: number, kind: string}>} segments
 * @param {Array<{start: number, end: number}>} hits
 * @param {number} [current]  index into `hits` of the match being visited
 * @returns {Array<{start: number, end: number, kind: string, hit: boolean, current: boolean}>}
 */
export function markHits(segments, hits, current = -1) {
  const marks = Array.isArray(hits) ? hits : [];
  const out = [];
  for (const seg of segments) {
    let at = seg.start;
    for (let index = 0; index < marks.length; index += 1) {
      const hit = marks[index];
      if (hit.end <= at) {
        continue;
      }
      if (hit.start >= seg.end) {
        break;
      }
      const from = Math.max(hit.start, at);
      const to = Math.min(hit.end, seg.end);
      if (from > at) {
        out.push({ start: at, end: from, kind: seg.kind, hit: false, current: false });
      }
      out.push({ start: from, end: to, kind: seg.kind, hit: true, current: index === current });
      at = to;
    }
    if (at < seg.end) {
      out.push({ start: at, end: seg.end, kind: seg.kind, hit: false, current: false });
    }
  }
  return out;
}

/* -------------------- editor -------------------- */

function renderEditor(card, ctx) {
  const { client, app } = ctx;
  /*
   * Language questions go to a subsystem, never to the kernel.  The client is
   * the shell's (`subsystem.request`), and `ctx.language` lets the app hand in
   * one shared instance so the catalog is asked once for the whole window
   * rather than once per card.
   */
  const language = ctx.language instanceof LanguageClient
    ? ctx.language
    : new LanguageClient({
      call: (method, params) => client.call(method, params),
      log: (level, message) => app.log(level, message),
    });

  const pre = h("pre", "ed-view", { attrs: { "aria-hidden": "true" } });
  const area = h("textarea", "ed-input", {
    attrs: { spellcheck: "false", autocomplete: "off", wrap: "off" },
  });
  const scroller = h("div", "ed-scroll", { children: [pre] });
  /*
   * Line numbers, on by default: the first thing anyone asks about a diagnostic
   * is which line it is on, and that answer should not cost a click.  A click
   * on the gutter turns them off for the sessions where the columns matter
   * more.  The numbers are one text node in a <pre> carrying the code's own
   * font, line height and top padding, so line N lands on line N with no
   * per-row layout at all -- only the textarea's vertical scroll is mirrored.
   */
  const gutterNumbers = h("pre", "ed-gutter-numbers", { attrs: { "aria-hidden": "true" } });
  const gutter = h("div", "ed-gutter", {
    attrs: {
      "data-role": "gutter", "data-on": "on", "data-lines": "1", "aria-hidden": "true",
      title: "line numbers \u2014 click to hide",
    },
    children: [gutterNumbers],
  });
  const surface = h("div", "ed-surface has-gutter", { children: [gutter, scroller, area] });

  /* The find bar.  It is part of the card, not a browser dialog: everything
     here has to keep working offline, and a modal would swallow the caret. */
  const findQuery = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "find", spellcheck: "false", autocomplete: "off",
      "data-role": "find-query", "aria-label": "find in this file",
    },
  });
  const findCount = h("span", "ed-find-count", {
    attrs: { "data-role": "find-count", "aria-live": "polite" },
  });
  const findPrev = h("button", "ed-find-btn", {
    text: "\u2191",
    attrs: { type: "button", title: "previous match (shift+enter)", "data-role": "find-prev" },
  });
  const findNext = h("button", "ed-find-btn", {
    text: "\u2193",
    attrs: { type: "button", title: "next match (enter)", "data-role": "find-next" },
  });
  const findClose = h("button", "ed-find-btn", {
    text: "\u00d7",
    attrs: { type: "button", title: "close the find bar (esc)", "data-role": "find-close" },
  });
  const replaceText = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "replace with", spellcheck: "false", autocomplete: "off",
      "data-role": "replace-text", "aria-label": "replace with",
    },
  });
  const replaceOne = h("button", "ed-find-btn ed-find-wide", {
    text: "replace",
    attrs: { type: "button", title: "replace this match", "data-role": "replace-one" },
  });
  const replaceAll = h("button", "ed-find-btn ed-find-wide", {
    text: "all",
    attrs: { type: "button", title: "replace every match", "data-role": "replace-all" },
  });
  const findBar = h("div", "ed-find", {
    attrs: { hidden: "", "data-role": "find-bar" },
    children: [
      h("div", "ed-find-row", { children: [findQuery, findCount, findPrev, findNext, findClose] }),
      h("div", "ed-find-row", { children: [replaceText, replaceOne, replaceAll] }),
    ],
  });

  /*
   * The completion list and the issue strip are docked rows under the editor
   * rather than floating popups.  A `<textarea>` has no selection rectangle to
   * read, and a mirror element just to place a popup would be a second copy of
   * the text that can disagree with the real one.  Docked is honest, keyboard
   * first, and correct at every zoom -- and it is exactly the same information.
   */
  const completionList = h("div", "ed-complete-list", {
    attrs: { "data-role": "completion-list", role: "listbox", "aria-label": "completions" },
  });
  const completionBar = h("div", "ed-complete", {
    attrs: { hidden: "", "data-role": "completion" },
    children: [completionList],
  });
  const issueList = h("div", "ed-issues-list", {
    attrs: { "data-role": "issues-list" },
  });
  const issueBar = h("div", "ed-issues", {
    attrs: { hidden: "", "data-role": "issues" },
    children: [issueList],
  });

  const status = makeStatus();
  const body = h("div", "card-body card-body-editor", {
    children: [findBar, surface, completionBar, issueBar, status],
  });

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    tokens: [],
    timer: null,
    tokenSeq: 0,
    findOpen: false,
    hits: [],
    hitIndex: -1,
    // Language: the completion list, which row is highlighted, the issues the
    // last answer named, and the generation counters that keep a stale reply
    // from overwriting a newer one.
    completions: [],
    completionIndex: -1,
    completionSeq: 0,
    completionTimer: null,
    source: null,
    issues: [],
    issueSeq: 0,
    issueTimer: null,
    // The line-number gutter: on unless the reader hid it, and the line count
    // the numbers were painted for.
    gutterOn: true,
    gutterLines: 0,
  };

  const shell = cardShell(card, body);
  shell.label.textContent = state.path || "(no file)";
  shell.label.title = state.path;

  // The last thing this card did that the user should know about: "loaded · lf ·
  // 4 bytes", "reloaded from disk", "saved", "write failed".  A bare
  // renderStatus() repaints for a new revision or a new issue count and must not
  // eat that sentence -- whether the editor read this file or the watcher noticed
  // it change under you is the whole difference the sentence exists to make.
  let statusNote = "";

  function renderStatus(message) {
    if (message) {
      statusNote = message;
    }
    const bits = [];
    if (state.path === "") {
      bits.push("no file — type `open <path>` below");
    } else {
      bits.push(state.path);
      if (state.dirty) {
        bits.push("modified");
      } else if (state.baseRevision !== null) {
        bits.push(`rev ${state.baseRevision}`);
      }
      if (state.saving) {
        bits.push("saving…");
      }
    }
    if (statusNote) {
      bits.push(statusNote);
    }
    status.textContent = bits.join(" · ");
  }

  /**
   * The numbers are one text node.  A file's line count only changes when a
   * newline is added or removed, so the string is rebuilt then and not on every
   * keystroke; the gutter never lays out a row per line.
   */
  function paintGutter() {
    const lines = area.value === "" ? 1 : area.value.split("\n").length;
    if (state.gutterLines !== lines) {
      let text = "1";
      for (let n = 2; n <= lines; n++) {
        text += `\n${n}`;
      }
      gutterNumbers.textContent = text;
      state.gutterLines = lines;
    }
    gutter.dataset.lines = String(lines);
  }

  function showGutter(on) {
    state.gutterOn = on === true;
    gutter.dataset.on = state.gutterOn ? "on" : "off";
    // Hiding the gutter hands its columns back to the code, so the scroller and
    // the textarea move left again -- they are inset behind it, one width.
    surface.classList.toggle("has-gutter", state.gutterOn);
    surface.classList.toggle("no-gutter", !state.gutterOn);
    gutter.title = state.gutterOn ? "line numbers \u2014 click to hide" : "line numbers \u2014 click to show";
  }

  gutter.addEventListener("mousedown", (event) => {
    event.preventDefault();
    showGutter(!state.gutterOn);
    app.log("info", `line numbers ${state.gutterOn ? "on" : "off"}`);
  });

  function repaint() {
    paintTokens(pre, area.value, state.tokens, state.hits, state.hitIndex);
    paintGutter();
    syncScroll();
  }

  /**
   * Bookkeeping for the edits this card makes itself (indent, auto-indent,
   * replace): the same work the `input` event does, plus the selection the
   * operation asked to restore.
   */
  function edited(message, selectionStart, selectionEnd) {
    if (selectionStart !== undefined) {
      area.setSelectionRange(selectionStart, selectionEnd === undefined ? selectionStart : selectionEnd);
    }
    state.dirty = true;
    renderStatus(message);
    scheduleTokenize();
    app.boardTouched(true);
    syncFind({ reveal: false });
  }

  /**
   * Insert text through the browser's own editing command, if it will.
   *
   * Writing `.value` directly throws the textarea's undo stack away, which
   * would mean that one press of Tab costs the user every earlier Ctrl+Z in
   * that card.  `document.execCommand("insertText")` is deprecated, but it is
   * the only remaining way to make the edit an undoable user edit, and this
   * window only ever runs on Chromium.  Returns false when the command is
   * missing or refused, so the caller can fall back to a plain write.
   */
  function typeIn(text) {
    try {
      if (typeof document.execCommand === "function") {
        return document.execCommand("insertText", false, text) === true;
      }
    } catch {
      // Nothing to do here: the fallback below keeps the buffer correct.
    }
    return false;
  }

  /**
   * Replace the whole buffer and restore the selection the operation asked for.
   * The text goes in as one user edit when the browser cooperates, so a single
   * Ctrl+Z takes the whole operation back rather than clearing the undo stack.
   *
   * @returns {boolean} whether the browser's own insert path was used
   */
  function rewrite(nextText, selectionStart, selectionEnd, message) {
    let typed = false;
    if (nextText !== area.value) {
      area.select();
      typed = typeIn(nextText);
      if (!typed) {
        area.value = nextText;
      }
    }
    edited(message, selectionStart, selectionEnd);
    return typed;
  }

  function syncScroll() {
    scroller.scrollTop = area.scrollTop;
    scroller.scrollLeft = area.scrollLeft;
    // The numbers ride the same offset.  A transform keeps the gutter out of
    // the layout, so a scroll costs one compositor step and no reflow.
    gutterNumbers.style.transform = `translateY(${-area.scrollTop}px)`;
  }

  area.addEventListener("scroll", syncScroll);

  /* ---- find and replace ---- */

  function showCount() {
    if (!state.findOpen) {
      findCount.textContent = "";
      return;
    }
    if (findQuery.value === "") {
      findCount.textContent = "";
    } else if (state.hits.length === 0) {
      findCount.textContent = "no match";
    } else {
      findCount.textContent = `${state.hitIndex + 1}/${state.hits.length}`;
    }
  }

  /** Start from the first match at or after the caret, else from the top. */
  function seedIndex() {
    if (state.hits.length === 0) {
      state.hitIndex = -1;
      return;
    }
    const caret = area.selectionStart;
    const found = state.hits.findIndex((hit) => hit.start >= caret);
    state.hitIndex = found === -1 ? 0 : found;
  }

  /**
   * Recompute the matches and repaint.  `reveal` scrolls the current one into
   * view; `seed` picks a new current match rather than keeping the old index.
   */
  function syncFind(options = {}) {
    const { reveal = true, seed = false } = options;
    state.hits = state.findOpen ? findMatches(area.value, findQuery.value) : [];
    if (state.hits.length === 0) {
      state.hitIndex = -1;
    } else if (seed) {
      seedIndex();
    } else if (state.hitIndex >= state.hits.length) {
      state.hitIndex = state.hits.length - 1;
    } else if (state.hitIndex < 0) {
      state.hitIndex = 0;
    }
    showCount();
    repaint();
    if (reveal && state.hitIndex >= 0) {
      standOnHit();
    }
  }

  /** The text node holding a string index, and the offset inside it. */
  function pointAt(target) {
    let seen = 0;
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const length = child.data.length;
          if (target <= seen + length) {
            return { node: child, offset: target - seen };
          }
          seen += length;
        } else {
          const found = walk(child);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }
    return walk(pre);
  }

  /**
   * Scroll the current match into view.
   *
   * The measurement is taken from the same text in the `<pre>`, which shares
   * the textarea's metrics; the delta is then applied to the textarea's own
   * scroll position, which `syncScroll` mirrors back onto the `<pre>`.
   */
  function revealHit(hit) {
    const first = pointAt(hit.start);
    const last = pointAt(hit.end);
    if (first === null || last === null) {
      return;
    }
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return;
    }
    const frame = surface.getBoundingClientRect();
    let dy = 0;
    let dx = 0;
    if (box.top < frame.top) {
      dy = box.top - frame.top - 6;
    } else if (box.bottom > frame.bottom) {
      dy = box.bottom - frame.bottom + 6;
    }
    if (box.left < frame.left) {
      dx = box.left - frame.left - 6;
    } else if (box.right > frame.right) {
      dx = box.right - frame.right + 6;
    }
    if (dy !== 0) {
      area.scrollTop += dy;
    }
    if (dx !== 0) {
      area.scrollLeft += dx;
    }
    syncScroll();
  }

  /** Stand on the current match: select it and bring it into view. */
  function standOnHit() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      return;
    }
    area.setSelectionRange(hit.start, hit.end);
    revealHit(hit);
  }

  /** Move to the next (or previous) match, wrapping around. */
  function stepHit(delta) {
    const count = state.hits.length;
    if (count === 0) {
      syncFind({ reveal: false, seed: true });
      return;
    }
    const base = state.hitIndex < 0 ? (delta > 0 ? -1 : 0) : state.hitIndex;
    state.hitIndex = ((base + delta) % count + count) % count;
    showCount();
    repaint();
    standOnHit();
  }

  function openFind() {
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    if (!state.findOpen && selected !== "" && !selected.includes("\n")) {
      findQuery.value = selected;
    }
    state.findOpen = true;
    findBar.hidden = false;
    syncFind({ reveal: true, seed: true });
    findQuery.focus();
    findQuery.select();
  }

  function closeFind() {
    state.findOpen = false;
    findBar.hidden = true;
    state.hits = [];
    state.hitIndex = -1;
    showCount();
    repaint();
    area.focus();
  }

  function replaceCurrent() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      openFind();
      return;
    }
    const replacement = replaceText.value;
    const caret = hit.start + replacement.length;
    rewrite(replaceMatchAt(area.value, hit, replacement), caret, undefined, "replaced 1");
  }

  function replaceEvery() {
    const query = findQuery.value;
    const hits = findMatches(area.value, query);
    if (hits.length === 0) {
      renderStatus("nothing to replace");
      return;
    }
    const replacement = replaceText.value;
    const caret = hits[0].start + replacement.length;
    rewrite(replaceAllMatches(area.value, query, replacement).text, caret, undefined,
      `replaced ${hits.length}`);
  }

  findQuery.addEventListener("input", () => {
    syncFind({ reveal: true, seed: true });
  });
  findQuery.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  });
  replaceText.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });
  findPrev.addEventListener("click", () => stepHit(-1));
  findNext.addEventListener("click", () => stepHit(1));
  findClose.addEventListener("click", closeFind);
  replaceOne.addEventListener("click", replaceCurrent);
  replaceAll.addEventListener("click", replaceEvery);

  /**
   * Re-tokenise and repaint.
   *
   * The textarea is never rewritten, so the caret and the selection survive;
   * only the `<pre>` underneath is replaced.  A stale reply (the user typed
   * while the kernel was answering) is discarded.
   */
  async function tokenizeNow() {
    const text = area.value;
    const path = state.path;
    if (path === "") {
      state.tokens = [];
      repaint();
      return;
    }
    const seq = state.tokenSeq + 1;
    state.tokenSeq = seq;
    let tokens = [];
    try {
      const result = await client.call("lang.tokenize", { path, text });
      tokens = Array.isArray(result && result.tokens) ? result.tokens : [];
    } catch {
      // Colouring is decoration: a failing tokenizer must not disturb editing.
      tokens = [];
    }
    if (seq !== state.tokenSeq || area.value !== text) {
      return;
    }
    state.tokens = tokens;
    repaint();
  }

  function scheduleTokenize() {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      tokenizeNow();
    }, 120);
  }

  /* ---- language: completion, diagnostics, hover, definition ---- */

  /*
   * Words from the *other* open editors, for the completion list.  The handle
   * exposes a card's path and dirty flag, not its text, so this stays empty
   * today: `words` completes from the buffer in front of you, and a project
   * word list would be a second source of truth about text this card does not
   * own.  The wire already carries the member (`words`), so filling it in later
   * is a client change and nothing else.
   */
  function projectWords() {
    return [];
  }

  function renderCompletions(answer) {
    completionList.replaceChildren();
    state.completions.forEach((item, index) => {
      const row = h("div", index === state.completionIndex ? "ed-complete-row on" : "ed-complete-row", {
        attrs: {
          role: "option",
          "aria-selected": index === state.completionIndex ? "true" : "false",
          "data-role": "completion-row",
        },
        text: item.label,
      });
      if (item.detail) {
        row.title = String(item.detail);
      }
      row.addEventListener("mousedown", (event) => {
        // mousedown, not click: the textarea must not lose the caret first.
        event.preventDefault();
        state.completionIndex = index;
        acceptCompletion();
      });
      completionList.append(row);
    });
    const shown = state.completions.length;
    completionBar.hidden = false;
    // Which subsystem answered, as data: the status line above says it in words,
    // and the shell's smoke test reads it back to name the source it proved.
    completionBar.dataset.source = state.source;
    renderStatus(`${shown}${answer.truncated ? "+" : ""} from ${state.source}${showCountHint()}`);
  }

  function showCountHint() {
    return state.issues.length === 0 ? "" : ` · ${state.issues.length} issue${state.issues.length === 1 ? "" : "s"}`;
  }

  function closeCompletions() {
    state.completions = [];
    state.completionIndex = -1;
    completionList.replaceChildren();
    completionBar.hidden = true;
  }

  async function requestCompletions() {
    if (state.path === "") {
      app.log("warn", "no file: there is nothing to complete in");
      return;
    }
    const text = area.value;
    const offset = area.selectionStart;
    const seq = state.completionSeq + 1;
    state.completionSeq = seq;
    let answer = null;
    try {
      answer = await language.complete({ path: state.path, text, offset, words: projectWords() });
    } catch (err) {
      app.log("warn", `completion failed: ${err.message}`);
      return;
    }
    // A reply that lost the race is dropped: the caret moved, so the list would
    // be about a different position.
    if (seq !== state.completionSeq || area.value !== text || area.selectionStart !== offset) {
      return;
    }
    if (answer === null || answer.items.length === 0) {
      closeCompletions();
      renderStatus("no completions");
      return;
    }
    state.completions = answer.items;
    state.completionIndex = 0;
    state.source = answer.source;
    renderCompletions(answer);
  }

  function stepCompletion(delta) {
    const count = state.completions.length;
    if (count === 0) {
      return;
    }
    state.completionIndex = ((state.completionIndex + delta) % count + count) % count;
    renderCompletions({ truncated: false });
    const row = completionList.children[state.completionIndex];
    if (row !== undefined && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * Insert the highlighted completion.
   *
   * The edit goes in as one user edit (`rewrite` -> `execCommand`), so Ctrl+Z
   * takes it back; the caret lands after the inserted word, and the list closes.
   */
  function acceptCompletion() {
    const item = state.completions[state.completionIndex];
    if (item === undefined) {
      closeCompletions();
      return;
    }
    const next = insertCompletion(area.value, area.selectionStart, item.label);
    closeCompletions();
    if (next.text !== area.value) {
      rewrite(next.text, next.caret, next.caret, `inserted ${item.label}`);
    } else {
      area.setSelectionRange(next.caret, next.caret);
    }
  }

  /* ---- the issue strip ---- */

  function renderIssues() {
    issueList.replaceChildren();
    for (const issue of state.issues) {
      const row = h("div", `ed-issue sev-${issue.severity}`, {
        attrs: { "data-role": "issue-row", "data-severity": issue.severity },
        text: formatDiagnostic(issue),
      });
      row.title = issue.code === null ? issue.message : `${issue.code}: ${issue.message}`;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        area.focus();
        area.setSelectionRange(issue.start, issue.end > issue.start ? issue.end : issue.start);
        renderStatus(formatDiagnostic(issue));
      });
      issueList.append(row);
    }
    issueBar.dataset.source = state.source;
    issueBar.hidden = state.issues.length === 0;
  }

  /** Jump the caret to the next issue after it, wrapping. */
  function stepIssue(delta) {
    if (state.issues.length === 0) {
      app.log("info", "no issues here");
      return;
    }
    const caret = area.selectionStart;
    const forward = delta >= 0;
    let index = forward
      ? state.issues.findIndex((issue) => issue.start > caret)
      : -1;
    if (!forward) {
      for (let i = state.issues.length - 1; i >= 0; i -= 1) {
        if (state.issues[i].start < caret) {
          index = i;
          break;
        }
      }
    }
    if (index === -1) {
      index = forward ? 0 : state.issues.length - 1;
    }
    const issue = state.issues[index];
    area.focus();
    area.setSelectionRange(issue.start, issue.end > issue.start ? issue.end : issue.start);
    renderStatus(`${index + 1}/${state.issues.length} · ${formatDiagnostic(issue)}`);
  }

  /**
   * Ask what is wrong with the buffer.
   *
   * Debounced harder than tokenising: a language server is a process, and one
   * question per keystroke would be one round trip per keystroke.  A reply for a
   * buffer that has since changed is dropped, so the strip never describes text
   * the user cannot see.
   */
  async function diagnoseNow() {
    const text = area.value;
    const path = state.path;
    if (path === "") {
      state.issues = [];
      issueBar.dataset.answer = "no file";
      renderIssues();
      renderStatus();
      return;
    }
    const seq = state.issueSeq + 1;
    state.issueSeq = seq;
    let answer = null;
    try {
      answer = await language.diagnose({ path, text });
    } catch (err) {
      app.log("warn", `diagnostics failed: ${err.message}`);
      return;
    }
    if (seq !== state.issueSeq || area.value !== text) {
      return;
    }
    state.issues = answer === null ? [] : answer.diagnostics;
    state.source = answer === null ? state.source : answer.source;
    // What the answer said, as data.  The strip shows the rows; a reader needs
    // to be able to tell "the server says there is nothing wrong" from "the
    // server has not said anything about this text yet", and the shell's smoke
    // test reads both back.
    issueBar.dataset.answer = answer === null
      ? "none"
      : `${state.issues.length} of ${answer.total}${answer.truncated ? "+" : ""}${answer.stale ? " stale" : ""}`;
    renderIssues();
    renderStatus();
  }

  function scheduleDiagnose() {
    if (state.issueTimer !== null) {
      clearTimeout(state.issueTimer);
    }
    state.issueTimer = setTimeout(() => {
      state.issueTimer = null;
      diagnoseNow();
    }, 400);
  }

  /* ---- hover and definition ---- */

  async function showHover() {
    if (state.path === "") {
      return;
    }
    const text = area.value;
    const offset = area.selectionStart;
    const answer = await language.hover({ path: state.path, text, offset });
    if (answer === null) {
      app.log("info", "nothing to say about that");
      return;
    }
    const first = answer.contents.split("\n").find((line) => line.trim() !== "") || answer.contents;
    app.log("info", `${first.trim()} (${answer.source})`);
  }

  async function goToDefinition() {
    if (state.path === "") {
      return;
    }
    const text = area.value;
    const offset = area.selectionStart;
    const answer = await language.definition({ path: state.path, text, offset });
    if (answer === null) {
      app.log("info", "no definition here");
      return;
    }
    const first = answer.locations[0];
    app.log("info", `${first.path}:${first.line} (${answer.source})`);
    app.openFile(first.path, { line: first.line });
  }

  /**
   * The load currently in flight (or the last one), so `goToLine` can wait for
   * the file a card is opening instead of jumping into an empty textarea.
   */
  let loading = Promise.resolve(false);

  /** Load (or reload) the file. Local edits are only discarded after a prompt. */
  function load(path, options = {}) {
    loading = loadNow(path, options);
    return loading;
  }

  async function loadNow(path, options = {}) {
    const { confirmDiscard = true, status = null } = options;
    if (state.dirty && confirmDiscard && !app.confirmDiscard(state.path)) {
      return false;
    }
    state.path = path;
    card.file = path;
    shell.label.textContent = path;
    shell.label.title = path;
    renderStatus("loading…");
    try {
      const result = await client.call("file.read", { path });
      area.value = typeof result.text === "string" ? result.text : "";
      state.baseRevision = result.revision;
      state.dirty = false;
      const parts = ["loaded", result.eol || "lf"];
      if (Number.isFinite(result.size)) {
        parts.push(`${result.size} bytes`);
      }
      renderStatus(parts.join(" · "));
      if (status !== null) {
        // Why this load happened. "loaded · lf · 14 bytes" is the same line
        // whether the user asked for the file or the watcher re-read it, and
        // after an external change the difference is the whole story.
        renderStatus(status);
      }
      scheduleTokenize();
      // A file that just arrived is worth asking about once, without waiting for
      // a keystroke: the issues are the first thing a reader wants to know.
      diagnoseNow();
      return true;
    } catch (err) {
      renderStatus("could not read");
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
  }

  /**
   * Put the caret at the start of a 1-based line and bring it into view.
   *
   * Waits for a load in flight: a search hit can open a card whose file has not
   * arrived yet, and jumping into an empty textarea would look like a failure.
   * The line is clamped, so a hit from a file edited since the search lands on
   * the nearest real line instead of throwing.
   */
  async function goToLine(line) {
    await loading;
    const wanted = Math.floor(Number(line));
    if (!Number.isFinite(wanted) || wanted < 1) {
      return false;
    }
    const text = area.value;
    let start = 0;
    let current = 1;
    while (current < wanted) {
      const next = text.indexOf("\n", start);
      if (next === -1) {
        break;
      }
      start = next + 1;
      current += 1;
    }
    area.focus();
    area.setSelectionRange(start, start);
    // A focused textarea scrolls its own caret into view; the coloured <pre>
    // underneath is a separate element, so it is moved by hand.
    syncScroll();
    return true;
  }

  /**
   * Write the buffer.
   *
   * `base_revision` is the revision from the last read or write.  If another
   * writer got there first the kernel answers `STALE_REVISION`; nothing is
   * overwritten and the user is asked what to do (`app.resolveStale`).
   */
  async function save() {
    if (state.path === "" || state.saving) {
      return false;
    }
    state.saving = true;
    renderStatus();
    const params = { path: state.path, text: area.value };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write", params);
      state.baseRevision = result.revision;
      state.dirty = false;
      renderStatus("saved");
      app.log("info", `saved ${state.path} (rev ${result.revision})`);
      return true;
    } catch (err) {
      if (client.isStaleRevision(err)) {
        const current = err.data && err.data.current_revision !== undefined
          ? err.data.current_revision
          : null;
        renderStatus(`stale — the file changed on disk (rev ${current})`);
        const choice = await app.resolveStale({ path: state.path, current, cardId: card.id });
        if (choice === "reload") {
          state.saving = false;
          state.dirty = false;
          return load(state.path, { confirmDiscard: false });
        }
        if (choice === "overwrite") {
          state.baseRevision = current;
          state.saving = false;
          return save();
        }
        app.log("warn", `${state.path} not saved; your text is still in the card`);
        return false;
      }
      renderStatus("write failed");
      app.log("error", `file.write ${state.path}: ${err.message}`);
      return false;
    } finally {
      if (state.saving) {
        // Only clear it when we are really finished (the stale path re-enters).
        state.saving = false;
      }
      renderStatus();
    }
  }

  area.addEventListener("input", () => {
    state.dirty = true;
    renderStatus();
    scheduleTokenize();
    scheduleDiagnose();
    // The caret moved with the text, so a completion list about the old one is
    // no longer true.
    closeCompletions();
    app.boardTouched(true);
    if (state.findOpen) {
      syncFind({ reveal: false });
    }
  });

  area.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    // While the list is up it owns the keys it needs, and only those: anything
    // else falls through to the editor below.
    if (!completionBar.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        stepCompletion(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptCompletion();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCompletions();
        return;
      }
    }
    if (mod && event.key === " ") {
      event.preventDefault();
      requestCompletions();
      return;
    }
    if (event.key === "F12") {
      event.preventDefault();
      goToDefinition();
      return;
    }
    if (mod && event.key.toLowerCase() === "i") {
      event.preventDefault();
      showHover();
      return;
    }
    if (mod && event.key === ".") {
      event.preventDefault();
      stepIssue(event.shiftKey ? -1 : 1);
      return;
    }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "Escape" && state.findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    // Tab indents: this is a text editor, and Tab is how text is indented.
    // Shift+Tab takes one step back off the lines the selection touches.
    if (event.key === "Tab") {
      event.preventDefault();
      const result = indentSelection(area.value, area.selectionStart, area.selectionEnd, {
        outdent: event.shiftKey,
      });
      if (result.text !== area.value) {
        rewrite(result.text, result.selectionStart, result.selectionEnd);
      }
      return;
    }
    // Enter keeps the line's indentation (plus one step after an opener).  A
    // top-level line is left to the browser, and the lines we do handle go in
    // through the browser's own insert command, so Ctrl+Z still has them.
    if (event.key === "Enter" && !mod && !event.altKey && !event.shiftKey
      && area.selectionStart === area.selectionEnd) {
      const before = area.value.slice(0, area.selectionStart);
      const indent = indentAfterEnter(before.slice(before.lastIndexOf("\n") + 1));
      if (indent !== "") {
        event.preventDefault();
        const at = area.selectionStart;
        rewrite(`${before}\n${indent}${area.value.slice(at)}`, at + 1 + indent.length);
        return;
      }
    }
    // Card-level shortcuts must not fire while typing.
    event.stopPropagation();
  });

  if (state.path !== "") {
    load(state.path, { confirmDiscard: false });
  } else {
    repaint();
    renderStatus();
  }

  return {
    el: shell.el,
    handle: {
      kind: "editor",
      save,
      load,
      goToLine,
      focus() {
        area.focus();
      },
      get path() {
        return state.path;
      },
      get dirty() {
        return state.dirty;
      },
      hasPath(path) {
        return state.path === path;
      },
      /**
       * The revision this card last read (or wrote), or `null` before the first
       * read answers. `file.stat` is compared against it.
       */
      get revision() {
        return state.baseRevision;
      },
      /**
       * Adopt the file as it is on disk now, discarding the buffer.
       *
       * Only a clean card is ever asked: the rule that decides is in
       * `watch.mjs`, and it warns instead of reloading whenever `dirty` is set.
       * The guard here is for the race (the user typed between the decision and
       * this call), not for the normal path.
       */
      reload() {
        if (state.dirty) {
          return Promise.resolve(false);
        }
        return load(state.path, { confirmDiscard: false, status: "reloaded from disk" });
      },
      /** The file is gone from disk: say so. The text stays, `^S` writes it back. */
      onFileGone() {
        renderStatus("gone from disk — ^S writes it back");
        app.log("warn", `${state.path} is gone from disk`);
      },
      /** Open the find bar (the smoke test drives it through real keys too). */
      find() {
        openFind();
        return { query: findQuery.value, hits: state.hits.length, index: state.hitIndex };
      },
      /**
       * Language questions, awaited by the smoke test.
       *
       * The UI paths are the real ones (`^Space`, `F12`); these just return the
       * promise so a check can wait for the answer instead of guessing a delay.
       */
      complete: requestCompletions,
      diagnose: diagnoseNow,
      hover: showHover,
      definition: goToDefinition,
      get completions() {
        return state.completions.map((item) => item.label);
      },
      get issues() {
        return state.issues.map((issue) => ({ ...issue }));
      },
      /** External change: report it, never auto-reload over unsaved edits. */
      onFileChanged(revision) {
        if (revision !== null && revision === state.baseRevision) {
          return;
        }
        renderStatus(`changed on disk (rev ${revision}) — ^S overwrites`);
        app.log("warn", `${state.path} changed on disk (rev ${revision})`);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
      state.tokenSeq += 1;
    },
  };
}

/* -------------------- runner -------------------- */

function renderRunner(card, ctx) {
  const { client, app } = ctx;
  const output = new OutputBuffer();
  const state = {
    runId: card.run_id !== undefined && card.run_id !== null ? card.run_id : null,
    running: false,
    exit: null,
    timer: null,
  };

  const cmdInput = h("input", "run-cmd", {
    attrs: { type: "text", spellcheck: "false", placeholder: "command…" },
  });
  cmdInput.value = typeof card.cmd === "string" ? card.cmd : "";

  const runButton = h("button", "card-button", { text: "run", attrs: { type: "button" } });
  const stopButton = h("button", "card-button", { text: "stop", attrs: { type: "button" } });
  const clearButton = h("button", "card-button", { text: "clear", attrs: { type: "button" } });
  const controls = h("div", "run-controls", {
    children: [cmdInput, runButton, stopButton, clearButton],
  });
  const view = h("pre", "run-out");
  const status = makeStatus();
  const body = h("div", "card-body card-body-runner", { children: [controls, view, status] });

  const shell = cardShell(card, body);
  const exitTag = h("span", "run-exit", { text: formatExit(state.exit) });
  shell.tools.append(exitTag);
  shell.label.textContent = "";

  function paint() {
    view.textContent = output.lines().join("\n");
    view.scrollTop = view.scrollHeight;
    exitTag.textContent = formatExit(state.exit);
    if (state.runId !== null) {
      status.textContent = `run ${state.runId} · ${state.running ? "running" : formatExit(state.exit)}`;
    } else {
      status.textContent = state.exit === null ? "not started" : formatExit(state.exit);
    }
    cmdInput.disabled = state.running;
    stopButton.disabled = !state.running;
  }

  /** Coalesce output into at most one repaint per interval. */
  function schedulePaint() {
    if (state.timer !== null) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      paint();
    }, 60);
  }

  async function start() {
    const cmd = cmdInput.value.trim();
    if (cmd === "") {
      app.log("warn", "run: empty command");
      return;
    }
    if (state.running) {
      app.log("warn", `card ${card.id} is already running`);
      return;
    }
    card.cmd = cmd;
    app.boardTouched(true);
    output.clear();
    state.exit = null;
    paint();
    try {
      const result = await client.call("proc.start", {
        cmd,
        cwd: typeof card.cwd === "string" && card.cwd !== "" ? card.cwd : ".",
      });
      state.runId = result.run_id;
      state.running = true;
      card.run_id = state.runId;
      app.registerRun(result.run_id, card.id);
      paint();
    } catch (err) {
      status.textContent = `could not start: ${err.message}`;
      app.log("error", `proc.start failed: ${err.message}`);
    }
  }

  async function stop() {
    if (state.runId === null) {
      return;
    }
    try {
      await client.call("proc.stop", { run_id: state.runId });
    } catch (err) {
      app.log("error", `proc.stop failed: ${err.message}`);
    }
  }

  runButton.addEventListener("click", start);
  stopButton.addEventListener("click", stop);
  clearButton.addEventListener("click", () => {
    output.clear();
    paint();
  });
  cmdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      start();
      return;
    }
    event.stopPropagation();
  });
  cmdInput.addEventListener("input", () => {
    card.cmd = cmdInput.value;
    app.boardTouched(true);
  });

  paint();

  return {
    el: shell.el,
    handle: {
      kind: "runner",
      start,
      stop,
      focus() {
        cmdInput.focus();
        cmdInput.select();
      },
      owns(runId) {
        return state.runId !== null && state.runId === runId;
      },
      /**
       * Adopt a run started before its reply landed, so output emitted in that
       * window is not dropped on the floor.
       */
      adopt(runId) {
        if (state.runId !== null && state.runId !== runId) {
          return false;
        }
        state.runId = runId;
        state.running = true;
        card.run_id = runId;
        paint();
        return true;
      },
      output(data) {
        output.append(data);
        schedulePaint();
      },
      exit(code) {
        state.exit = code;
        state.running = false;
        state.runId = null;
        paint();
        app.boardTouched(true);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
    },
  };
}

/* -------------------- note -------------------- */

function renderNote(card, ctx) {
  const { app } = ctx;
  const area = h("textarea", "note-input", {
    attrs: { spellcheck: "false", placeholder: "scratch…" },
  });
  area.value = typeof card.text === "string" ? card.text : "";
  const status = makeStatus();
  const body = h("div", "card-body card-body-note", { children: [area, status] });
  const shell = cardShell(card, body);

  function update() {
    const text = area.value;
    status.textContent = `${text.length} chars · stored in the board`;
    shell.label.textContent = text.split("\n")[0].slice(0, 48);
  }

  area.addEventListener("input", () => {
    card.text = area.value;
    update();
    app.boardTouched(true);
  });
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });
  update();

  return {
    el: shell.el,
    handle: {
      kind: "note",
      focus() {
        area.focus();
      },
    },
    destroy() {},
  };
}

/* -------------------- frame -------------------- */

/**
 * A frame is a named rectangle that moves whatever stands in it.
 *
 * It is the board's answer to "put these cards in a group".  A group has to
 * survive a reload, and the only thing the board keeps for good is the layout
 * itself -- so the group *is* a rectangle and membership is spatial.  There is
 * no member list to prune and none to drift, and a card joins or leaves the
 * group the moment it is dragged across the border.
 *
 * The cards inside are computed by `main.mjs` (`cardsInsideRect` in board.mjs)
 * rather than here: this file deliberately imports nothing, and a card is told
 * everything it knows through `ctx.app`.  A card that merely clips the border
 * is not inside -- the centre has to stand in the frame -- which is documented
 * in `shell/web/README.md` along with what overlapping frames do.
 */
function renderFrame(card, ctx) {
  const { app } = ctx;
  const titleInput = h("input", "frame-title", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "group name",
      "data-role": "frame-title",
    },
  });
  titleInput.value = typeof card.title === "string" ? card.title : "";
  const count = h("span", "frame-count", { attrs: { "data-role": "frame-count" } });
  const status = makeStatus();
  const body = h("div", "card-body card-body-frame", {
    children: [titleInput, count, status],
  });
  const shell = cardShell(card, body);

  function inside() {
    return typeof app.frameMembers === "function" ? app.frameMembers(card) : [];
  }

  function update() {
    const held = inside().length;
    count.textContent = held === 1 ? "1 card inside" : `${held} cards inside`;
    shell.label.textContent = card.title === undefined || card.title === "" ? "(unnamed)" : card.title;
    status.textContent = held === 0
      ? "empty — drag a card in to group it"
      : "drag the frame to move the cards inside it";
  }

  titleInput.addEventListener("input", () => {
    card.title = titleInput.value;
    update();
    app.boardTouched(true);
  });
  titleInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  // The count is a function of where the cards are, so it has to follow the
  // board rather than be recomputed on some other card's edit.
  const off = typeof app.onBoardChanged === "function" ? app.onBoardChanged(() => update()) : null;
  update();

  return {
    el: shell.el,
    handle: {
      kind: "frame",
      focus() {
        titleInput.focus();
        titleInput.select();
      },
      inside,
      setTitle(text) {
        card.title = String(text);
        titleInput.value = card.title;
        update();
      },
    },
    destroy() {
      if (typeof off === "function") {
        off();
      }
    },
  };
}

/* -------------------- files -------------------- */

function renderFiles(card, ctx) {
  const { client, app } = ctx;
  const filterInput = h("input", "files-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const list = h("div", "files-list");
  const status = makeStatus();
  const body = h("div", "card-body card-body-files", {
    children: [filterInput, list, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = filterInput.value;

  let timer = null;
  let requestSeq = 0;

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: filter, limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const now = Math.floor(Date.now() / 1000);
    const { rows, count, truncated } = formatListing(listing, { now });
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const button = h("button", `file-row${row.dir ? " is-dir" : ""}`, {
        attrs: { type: "button", title: row.path },
      });
      button.append(h("span", "file-name", { text: row.dir ? `${row.name}/` : row.name }));
      button.append(h("span", "file-meta", {
        text: [row.sizeText, row.ageText].filter(Boolean).join(" "),
      }));
      button.addEventListener("click", () => {
        if (row.dir) {
          filterInput.value = `${row.path}/**/*`;
          card.filter = filterInput.value;
          shell.label.textContent = filterInput.value;
          app.boardTouched(true);
          refresh();
          return;
        }
        app.openFile(row.path);
      });
      frag.append(button);
    }
    list.textContent = "";
    list.append(frag);
    status.textContent = `${rows.length}/${count} entries${truncated ? " · truncated" : ""}`;
  }

  function scheduleRefresh() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, 180);
  }

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    shell.label.textContent = filterInput.value;
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });

  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "files",
      refresh,
      focus() {
        filterInput.focus();
        filterInput.select();
      },
    },
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      requestSeq += 1;
    },
  };
}

/* -------------------- search -------------------- */

/**
 * The search card: one query, the whole workspace, and a click that opens the
 * file at the line.
 *
 * The board has no tree and no grep, so finding a word in the workspace was the
 * one thing a person had to leave seIDE for.  This card is all of it: a
 * `workspace.list`, a `file.read` per candidate, and rows that call
 * `app.openFile(path, {line})`.
 *
 * It is deliberately not incremental -- the search runs when the query is
 * submitted, not on every keystroke, because reading a workspace per keypress
 * is a way to make a quiet editor feel slow.  What it read, what it skipped and
 * what it stopped at live in the status line rather than in a promise.
 */
function renderSearch(card, ctx) {
  const { client, app } = ctx;
  const queryInput = h("input", "search-query", {
    attrs: {
      type: "text", spellcheck: "false", placeholder: "text to find",
      "data-role": "search-query", "aria-label": "text to find",
    },
  });
  queryInput.value = typeof card.query === "string" ? card.query : "";
  const globInput = h("input", "search-glob", {
    attrs: {
      type: "text", spellcheck: "false", placeholder: "**/*",
      "data-role": "search-glob", "aria-label": "files to search",
    },
  });
  globInput.value = typeof card.glob === "string" && card.glob !== "" ? card.glob : "**/*";
  const caseButton = h("button", "search-case", {
    text: "Aa",
    attrs: {
      type: "button", title: "match case", "data-role": "search-case", "aria-pressed": "false",
    },
  });
  const runButton = h("button", "search-run", {
    text: "find",
    attrs: { type: "button", title: "search the workspace", "data-role": "search-run" },
  });
  const head = h("div", "search-head", {
    children: [queryInput, globInput, caseButton, runButton],
  });
  const list = h("div", "search-list", { attrs: { "data-role": "search-list" } });
  const status = makeStatus();
  const body = h("div", "card-body card-body-search", { children: [head, list, status] });
  const shell = cardShell(card, body);

  let seq = 0;
  let caseSensitive = card.caseSensitive === true;

  function label() {
    const query = queryInput.value.trim();
    shell.label.textContent = query === "" ? "the workspace" : `“${query}”`;
  }

  function setCase(on) {
    caseSensitive = on === true;
    card.caseSensitive = caseSensitive;
    caseButton.classList.toggle("is-on", caseSensitive);
    caseButton.setAttribute("aria-pressed", caseSensitive ? "true" : "false");
  }

  function renderRows(outcome) {
    const frag = document.createDocumentFragment();
    let lastPath = null;
    for (const hit of outcome.hits) {
      if (hit.path !== lastPath) {
        lastPath = hit.path;
        frag.append(h("div", "search-file", {
          text: hit.path,
          attrs: { "data-role": "search-file", title: hit.path },
        }));
      }
      // `column` is 1-based within the line, which is exactly where the excerpt
      // has to cut: `hit.start` is an index into the whole file, not the line.
      const at = hit.column - 1;
      const excerpt = searchExcerpt(hit.text, at, at + (hit.end - hit.start));
      const row = h("button", "search-hit", {
        attrs: {
          type: "button",
          "data-role": "search-hit",
          "data-path": hit.path,
          "data-line": String(hit.line),
          "data-column": String(hit.column),
          title: `${hit.path}:${hit.line}:${hit.column}`,
        },
      });
      row.append(h("span", "search-where", { text: `${hit.line}:${hit.column}` }));
      row.append(h("span", "search-text", {
        children: [
          document.createTextNode(excerpt.leading),
          h("mark", "search-mark", { text: excerpt.hit }),
          document.createTextNode(excerpt.trailing),
        ],
      }));
      row.addEventListener("click", () => {
        app.openFile(hit.path, { line: hit.line });
      });
      frag.append(row);
    }
    list.textContent = "";
    list.append(frag);
  }

  async function run() {
    const query = queryInput.value.trim();
    card.query = queryInput.value;
    card.glob = globInput.value;
    app.boardTouched(true);
    label();
    if (query === "") {
      list.textContent = "";
      status.textContent = "type a word to find, or use `find <text>`";
      return 0;
    }
    const mine = seq + 1;
    seq = mine;
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", {
        glob: globInput.value.trim() || "**/*",
        limit: 4000,
      });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return 0;
    }
    if (mine !== seq) {
      return 0;
    }
    const candidates = (listing && Array.isArray(listing.files) ? listing.files : [])
      .filter((entry) => entry !== null && typeof entry === "object" && entry.dir !== true
        && typeof entry.path === "string" && entry.path !== "")
      .filter((entry) => !Number.isFinite(entry.size) || entry.size <= SEARCH_MAX_BYTES);
    const queue = candidates.slice(0, SEARCH_MAX_FILES);
    const files = [];
    let read = 0;
    let budget = 0;
    for (const entry of queue) {
      if (mine !== seq) {
        return 0;
      }
      let text;
      try {
        const result = await client.call("file.read", { path: entry.path });
        text = typeof result.text === "string" ? result.text : "";
      } catch {
        continue; // unreadable, or not text at all: a search skips it
      }
      read += 1;
      if (text.includes("\u0000")) {
        continue; // binary: NUL is the cheapest honest test there is
      }
      const found = searchInText(text, query, { caseSensitive, maxPerFile: SEARCH_MAX_PER_FILE });
      if (found.length === 0) {
        continue;
      }
      files.push({ path: entry.path, text });
      budget += found.length;
      if (budget >= SEARCH_MAX_HITS) {
        break;
      }
      if (files.length % 5 === 0) {
        status.textContent = `searching… ${read} read, ${files.length} with hits`;
      }
    }
    if (mine !== seq) {
      return 0;
    }
    const outcome = searchFiles(files, query, { caseSensitive });
    renderRows(outcome);
    const notes = [
      `${outcome.hits.length} hit${outcome.hits.length === 1 ? "" : "s"}`,
      `in ${outcome.matchedFiles} file${outcome.matchedFiles === 1 ? "" : "s"}`,
      `${read} read`,
    ];
    if (candidates.length > queue.length) {
      notes.push(`first ${queue.length} of ${candidates.length}`);
    }
    if (outcome.truncated) {
      notes.push(`stopped at ${SEARCH_MAX_HITS} hits`);
    }
    if (outcome.perFileCapped) {
      notes.push(`first ${SEARCH_MAX_PER_FILE} per file`);
    }
    status.textContent = notes.join(" · ");
    return outcome.hits.length;
  }

  function onKey(event) {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      run();
    } else if (event.key === "Escape") {
      event.target.blur();
    }
  }

  queryInput.addEventListener("input", () => {
    card.query = queryInput.value;
    app.boardTouched(true);
    label();
  });
  globInput.addEventListener("input", () => {
    card.glob = globInput.value;
    app.boardTouched(true);
  });
  queryInput.addEventListener("keydown", onKey);
  globInput.addEventListener("keydown", onKey);
  caseButton.addEventListener("click", () => {
    setCase(!caseSensitive);
    if (queryInput.value.trim() !== "") {
      run();
    }
  });
  runButton.addEventListener("click", () => {
    run();
  });

  setCase(caseSensitive);
  label();
  if (queryInput.value.trim() !== "") {
    run();
  } else {
    status.textContent = "type a word to find, or use `find <text>`";
  }

  return {
    el: shell.el,
    handle: {
      kind: "search",
      run,
      /** Point the card at a new query and search at once (`find <text>`). */
      setQuery(query) {
        queryInput.value = typeof query === "string" ? query : "";
        label();
        return run();
      },
      focus() {
        queryInput.focus();
        queryInput.select();
      },
      /** What the card is showing, for the smoke test and for `find`. */
      state() {
        return { query: queryInput.value, glob: globInput.value, caseSensitive };
      },
    },
    destroy() {
      seq += 1; // an in-flight search must not write into a card that is gone
    },
  };
}

/* -------------------- project -------------------- */

/**
 * The project panel: the one surface that treats the workspace as *one
 * project*.
 *
 * A normal IDE keeps a project so that editing many files is cheap: you can
 * see what the project contains and what you already have open, and you can
 * get from one to the other without hunting for a rectangle on the plane.
 * That is exactly what this card is -- `workspace.list` merged with the
 * board's editor cards -- and it is why it is a card and not a side panel:
 * where it sits is project state like everything else.
 *
 * It deliberately lists the *whole* workspace -- every file the kernel will
 * hand over, not just the ones the filter matches -- because the useful
 * sentence it can say is "this file is gone and a card still points at it",
 * and that needs the whole project.  Its one piece of state is `filter`, which
 * lives on the card and therefore in `.seide/board.json`.
 */
function renderProject(card, ctx) {
  const { client, app } = ctx;

  const rootLine = h("div", "project-root");
  const filterInput = h("input", "project-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*  (folder glob or a word)" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const refreshButton = h("button", "project-button", {
    attrs: { type: "button", title: "list the workspace again" },
    text: "refresh",
  });
  const controls = h("div", "project-controls", {
    children: [filterInput, refreshButton],
  });
  const openSection = h("div", "project-section project-open");
  const treeSection = h("div", "project-section project-tree");
  const status = makeStatus();
  const body = h("div", "card-body card-body-project", {
    children: [rootLine, controls, openSection, treeSection, status],
  });
  const shell = cardShell(card, body);

  let timer = null;
  let requestSeq = 0;
  let lastOpenSignature = null;

  /**
   * The directories the kernel never lists, as names (`workspace.info.ignored`).
   * Empty when an older or forked kernel does not report them, in which case the
   * panel simply says less instead of guessing.
   */
  function hiddenDirs() {
    const info = app.workspace();
    const names = info && Array.isArray(info.ignored) ? info.ignored : [];
    return names.filter((name) => typeof name === "string" && name !== "");
  }

  function updateLabel() {
    const filter = filterInput.value.trim() || "**/*";
    shell.label.textContent = filter === "**/*" ? "workspace" : filter;
  }

  /** What the board has open, as one string: the panel re-lists only on change. */
  function openSignature() {
    const parts = [];
    for (const entry of app.openEditors()) {
      parts.push(`${entry.id}:${entry.path}:${entry.dirty ? 1 : 0}`);
    }
    return parts.join("|");
  }

  function renderRoot() {
    const info = app.workspace();
    if (info === null || info === undefined) {
      rootLine.textContent = "workspace: the path was not reported by the kernel";
      return;
    }
    const name = typeof info.name === "string" && info.name !== "" ? info.name : info.root;
    rootLine.textContent = `${name} — ${info.root}`;
    // The tooltip is where "why is build/ missing?" gets answered: the kernel
    // skips these directory names while it walks and says so in this list.
    const hidden = hiddenDirs();
    rootLine.title = hidden.length === 0
      ? String(info.root)
      : `${info.root}\nnot listed by the kernel: ${hidden.join(", ")}`;
  }

  /** Open a project file: an existing card is revealed, a new one is placed. */
  function openProjectFile(path) {
    const card_ = app.openFile(path, { at: { x: card.x + card.w + 400, y: card.y + 240 } });
    if (card_ !== null && card_ !== undefined) {
      app.revealCard(card_.id);
    }
  }

  /** One row of the open list: click reveals the card, the x closes it. */
  function openRow(entry) {
    const classes = ["project-row", "is-open"];
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    if (!entry.present) {
      classes.push("is-missing");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [
        entry.folder === "" ? "" : `${entry.folder}/`,
        entry.dirty ? "unsaved" : "",
        entry.present ? "" : "file is gone",
      ].filter(Boolean).join(" · "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    if (entry.id !== "") {
      const close = h("button", "project-close", {
        attrs: { type: "button", title: `take the card for ${entry.path} off the board (the file is not touched)` },
        text: "\u00d7",
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        app.closeCard(entry.id);
      });
      row.append(close);
    }
    return row;
  }

  /** One row of the tree: click opens the file, or reveals it if it is open. */
  function treeRow(entry) {
    const classes = ["project-row"];
    if (entry.open) {
      classes.push("is-open");
    }
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-dot", { text: entry.open ? "\u25cf" : "" }));
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [entry.dirty ? "unsaved" : "", entry.sizeText, entry.ageText].filter(Boolean).join(" "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    return row;
  }

  function renderOpen(result) {
    openSection.textContent = "";
    if (result.openRows.length === 0) {
      openSection.append(h("div", "project-empty", { text: "nothing open yet — click a file below" }));
      return;
    }
    openSection.append(h("div", "project-heading", { text: `open · ${result.openRows.length}` }));
    for (const entry of result.openRows) {
      openSection.append(openRow(entry));
    }
  }

  function renderTree(result) {
    treeSection.textContent = "";
    if (result.groups.length === 0) {
      // A filter that matches nothing is usually a filter aimed at a directory
      // the kernel does not hand over, so name those directories here.
      const hidden = hiddenDirs();
      const why = result.counts.files === 0
        ? "this workspace has no files"
        : "no file matches the filter";
      treeSection.append(h("div", "project-empty", {
        text: hidden.length === 0 || result.counts.files === 0
          ? why
          : `${why} · the kernel does not list ${hidden.join(", ")}`,
      }));
      return;
    }
    for (const group of result.groups) {
      treeSection.append(h("div", "project-heading", { text: group.label }));
      for (const entry of group.rows) {
        treeSection.append(treeRow(entry));
      }
    }
  }

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: "**/*", limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const result = projectRows(listing, {
      open: app.openEditors(),
      filter,
    });
    lastOpenSignature = openSignature();
    renderRoot();
    renderOpen(result);
    renderTree(result);
    status.textContent = projectSummary(result.counts)
      + (result.counts.complete ? "" : " · truncated, so “missing” may over-report");
  }

  function scheduleRefresh() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, 180);
  }

  // The board is the source of truth for what is open, so opening or closing
  // an editor anywhere -- a command, the files card, this panel -- re-lists.
  // The signature check keeps a pan (which re-renders every card) from
  // re-listing, and a pan happens on every animation frame.
  const off = app.onBoardChanged(() => {
    if (openSignature() === lastOpenSignature) {
      return;
    }
    refresh();
  });

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    updateLabel();
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });
  refreshButton.addEventListener("click", () => refresh());

  updateLabel();
  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "project",
      refresh,
      /** Re-point the filter from outside (the `project <glob>` command). */
      setFilter(value) {
        const text = typeof value === "string" && value.trim() !== "" ? value.trim() : "**/*";
        if (filterInput.value !== text) {
          filterInput.value = text;
          card.filter = text;
          updateLabel();
          app.boardTouched(true);
        }
        refresh();
      },
      focus() {
        filterInput.focus();
        filterInput.select();
      },
    },
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      requestSeq += 1;
      off();
    },
  };
}

/* -------------------- sheet -------------------- */

/** True when the caret sits at the very start of a text-like control. */
function caretAtStart(node) {
  return typeof node.selectionStart !== "number" || node.selectionStart === 0;
}

/** True when the caret sits at the very end, or the control has no caret. */
function caretAtEnd(node) {
  return typeof node.selectionEnd !== "number" || node.selectionEnd >= node.value.length;
}

/**
 * The structured-data card.
 *
 * Nothing here is a textarea: the card's state is a nested object of columns
 * and rows, each cell a typed control.  The renderer never round-trips that
 * state through a string, which is the whole point -- it is the counterexample
 * to "a card is a file with a cursor".
 */
function renderSheet(card, ctx) {
  const { app } = ctx;
  card.doc = normaliseSheet(card.doc);
  if (typeof card.title !== "string") {
    card.title = "";
  }

  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", "sheet-grid", { children: [thead, tbody] });
  const scroll = h("div", "sheet-scroll", { children: [table] });
  const tools = h("div", "sheet-tools", {
    attrs: { "data-role": "sheet-tools" },
  });
  const status = makeStatus();
  const body = h("div", "card-body card-body-sheet", {
    children: [scroll, tools, status],
  });
  const shell = cardShell(card, body);

  const addRowButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-row" }, text: "+ row",
  });
  const addColumnButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-column" }, text: "+ column",
  });
  const tsvButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-tsv", title: "copy the sheet as TSV" },
    text: "TSV",
  });
  tools.append(addRowButton, addColumnButton, tsvButton);

  /** Focus target that survives a repaint. */
  let lastFocus = null;

  function commit() {
    app.boardTouched(true);
    updateStatus();
  }

  /** Status line for a sheet the caller already normalised. */
  function updateStatusFrom(sheet) {
    status.textContent = `${sheetSummaryOf(sheet)} · structured state, no text`;
    shell.label.textContent = card.title !== "" ? card.title : sheetSummaryOf(sheet);
  }

  function updateStatus() {
    updateStatusFrom(normaliseSheet(card.doc));
  }

  function cellNode(rowIndex, columnIndex) {
    return tbody.querySelector(`[data-cell="${rowIndex}:${columnIndex}"]`);
  }

  function focusCell(selection) {
    if (selection === null) {
      return;
    }
    lastFocus = selection;
    const node = cellNode(selection.row, selection.column);
    if (node !== null) {
      node.focus();
      if (typeof node.select === "function") {
        node.select();
      }
    }
  }

  function moveFrom(event, rowIndex, columnIndex) {
    let dRow = 0;
    let dColumn = 0;
    if (event.key === "ArrowDown" || event.key === "Enter") {
      dRow = 1;
    } else if (event.key === "ArrowUp") {
      dRow = -1;
    } else if (event.key === "ArrowRight" && caretAtEnd(event.target)) {
      dColumn = 1;
    } else if (event.key === "ArrowLeft" && caretAtStart(event.target)) {
      dColumn = -1;
    } else {
      event.stopPropagation();
      return;
    }
    const next = nextSheetSelection(card.doc, { row: rowIndex, column: columnIndex }, dRow, dColumn);
    focusCell(next);
    event.preventDefault();
    event.stopPropagation();
  }

  function bindCellKeys(control, rowIndex, columnIndex) {
    control.addEventListener("keydown", (event) => {
      moveFrom(event, rowIndex, columnIndex);
    });
  }

  function makeCellControl(row, column, rowIndex, columnIndex) {
    /* `row` and `column` belong to the paint's own normalised snapshot, so the
       value below is what `sheetCell(card.doc, ...)` would return, without
       normalising the document once per cell.  The handlers capture ids, never
       these objects: a write hands the document a fresh set of rows and
       columns, so an object captured at paint time is a sheet the card no
       longer holds and a write through it disappears at the next repaint. */
    const rowId = row.id;
    const columnId = column.id;
    const value = coerceSheetValue(column.type, row.cells[columnId]);
    let control;

    if (column.type === "bool") {
      control = h("button", "sheet-toggle", {
        attrs: { type: "button", "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const show = (on) => {
        control.textContent = on ? "true" : "false";
        control.setAttribute("aria-pressed", on ? "true" : "false");
        control.classList.toggle("is-on", on);
      };
      show(value);
      control.addEventListener("click", () => {
        /* Read and write the toggle in one normalise: the stored value comes
           back from the write, so nothing has to look the cell up again. */
        const stored = applySheetCell(card.doc, rowId, columnId, (on) => !on);
        show(stored === undefined ? false : stored);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    if (column.type === "choice") {
      control = h("select", "sheet-choice", {
        attrs: { "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const options = Array.isArray(column.options) ? column.options.slice() : [];
      if (!options.includes(value)) {
        options.unshift(value);
      }
      for (const option of options) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option === "" ? "(empty)" : option;
        control.append(node);
      }
      control.value = value;
      control.addEventListener("change", () => {
        applySheetCell(card.doc, rowId, columnId, () => control.value);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    control = h("input", "sheet-input", {
      attrs: {
        type: "text",
        spellcheck: "false",
        "data-cell": `${rowIndex}:${columnIndex}`,
      },
    });
    if (column.type === "number") {
      control.setAttribute("inputmode", "decimal");
      control.classList.add("is-number");
    }
    control.value = value === "" ? "" : String(value);
    control.addEventListener("change", () => {
      const stored = applySheetCell(card.doc, rowId, columnId, () => control.value);
      /* Show what the column's type actually stored ("  2  " -> "2"). */
      control.value = stored === undefined ? "" : String(stored);
      commit();
    });
    bindCellKeys(control, rowIndex, columnIndex);
    return control;
  }

  function makeColumnHeader(column, columnIndex) {
    /* `column` is the paint's snapshot; only its id is kept.  Anything the
       handlers below need to change they change in the live document through
       `updateSheetColumn`, which resolves the column by id -- a title typed
       after any cell edit used to land on an object the card had replaced. */
    const columnId = column.id;
    const cell = h("th", "sheet-col", { attrs: { "data-role": "sheet-col" } });

    const titleInput = h("input", "sheet-col-title", {
      attrs: { type: "text", spellcheck: "false", title: "column name" },
    });
    titleInput.value = column.title;
    titleInput.addEventListener("input", () => {
      /* Per keystroke: one normalise, and the status line is refreshed from the
         sheet the write returned instead of normalising a second time. */
      const sheet = updateSheetColumn(card.doc, columnId, { title: titleInput.value });
      if (sheet !== null) {
        updateStatusFrom(sheet);
      }
      app.boardTouched(true);
    });
    titleInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    const typeSelect = document.createElement("select");
    typeSelect.className = "sheet-col-type";
    typeSelect.setAttribute("title", "column type");
    for (const type of SHEET_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    }
    typeSelect.value = column.type;
    typeSelect.addEventListener("change", () => {
      /* A type change re-normalises every cell under the column. */
      updateSheetColumn(card.doc, columnId, { type: typeSelect.value });
      paint();
      commit();
    });

    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove column" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      if (removeSheetColumn(card.doc, columnId)) {
        paint();
        commit();
      } else {
        app.log("warn", "sheet: a sheet keeps at least one column");
      }
    });

    /* Name and remove share one line; the type selector gets its own, so a
       column reads as "what it is called" then "what it holds". */
    const head = h("div", "sheet-col-head", { children: [titleInput, drop] });
    cell.append(head, typeSelect);
    cell.setAttribute("data-column-index", String(columnIndex));
    return cell;
  }

  function makeRowHeader(row, rowIndex) {
    const rowId = row.id;
    const cell = h("th", "sheet-row-head", { attrs: { "data-role": "sheet-row" } });
    cell.append(h("span", "sheet-row-index", { text: String(rowIndex + 1) }));
    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove row" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      removeSheetRow(card.doc, rowId);
      paint();
      commit();
    });
    cell.append(drop);
    return cell;
  }

  function paint() {
    /* Normalise ONCE for the whole grid and paint from that snapshot.
       `sheetCell(doc, ...)` normalises the document it is handed, so calling it
       per cell made a paint cost O(cells x document) -- 2400 cells took ~2 s,
       and a large sheet could freeze the board inside a single paint.  The
       controls read their values out of this snapshot; every write resolves the
       live document by id (see `makeCellControl`). */
    const doc = card.doc;
    const sheet = normaliseSheet(doc);
    thead.textContent = "";
    tbody.textContent = "";

    const headRow = h("tr", "sheet-head-row");
    headRow.append(h("th", "sheet-corner", { attrs: { "data-role": "sheet-corner" } }));
    sheet.columns.forEach((column, columnIndex) => {
      headRow.append(makeColumnHeader(column, columnIndex));
    });
    thead.append(headRow);

    sheet.rows.forEach((row, rowIndex) => {
      const tr = h("tr", "sheet-row", { attrs: { "data-row-id": row.id } });
      tr.append(makeRowHeader(row, rowIndex));
      sheet.columns.forEach((column, columnIndex) => {
        const td = h("td", `sheet-cell is-${column.type}`);
        td.append(makeCellControl(row, column, rowIndex, columnIndex));
        tr.append(td);
      });
      tbody.append(tr);
    });

    if (lastFocus !== null) {
      const wanted = lastFocus;
      lastFocus = null;
      focusCell(wanted);
    }
  }

  addRowButton.addEventListener("click", () => {
    addSheetRow(card.doc);
    paint();
    commit();
  });
  addColumnButton.addEventListener("click", () => {
    addSheetColumn(card.doc);
    paint();
    commit();
  });
  tsvButton.addEventListener("click", () => {
    const tsv = sheetToTSV(card.doc);
    const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
    if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
      clipboard.writeText(tsv).then(
        () => app.log("info", `sheet ${card.id}: ${normaliseSheet(card.doc).rows.length} rows copied as TSV`),
        () => {
          app.log("info", "sheet TSV:");
          for (const line of tsv.split("\n")) {
            if (line !== "") {
              app.log("info", line);
            }
          }
        },
      );
      return;
    }
    app.log("info", "sheet TSV:");
    for (const line of tsv.split("\n")) {
      if (line !== "") {
        app.log("info", line);
      }
    }
  });

  paint();
  updateStatus();

  return {
    el: shell.el,
    handle: {
      kind: "sheet",
      repaint: paint,
      focus() {
        focusCell({ row: 0, column: 0 });
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* registrations                                                          */
/* ------------------------------------------------------------------ */

/*
 * The kinds the prototype ships.  Each registration is self-contained: a fork
 * that wants a different note card replaces this object, not a case in a switch
 * three hundred lines away.  Adding another is one more call, and the board, the
 * command line and the kernel need no change at all -- `card.kind` is already an
 * open string everywhere else.
 */

registerCardKind({
  kind: "editor",
  title: "Editor",
  describe: (card) => `editor ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderEditor,
});

registerCardKind({
  kind: "runner",
  title: "Runner",
  describe: (card) => `runner ${card.cmd || "(no command)"}`,
  create: () => ({ cmd: "", cwd: "" }),
  render: renderRunner,
});

registerCardKind({
  kind: "note",
  title: "Note",
  describe: (card) => `note ${card.id}`,
  create: () => ({ text: "" }),
  render: renderNote,
});

registerCardKind({
  kind: "files",
  title: "Files",
  describe: (card) => `files ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderFiles,
});

registerCardKind({
  kind: "search",
  title: "Search",
  describe: (card) => `search ${card.query !== "" && card.query !== undefined ? card.query : "(no query)"}`,
  create: () => ({ query: "", glob: "**/*", caseSensitive: false }),
  render: renderSearch,
});

registerCardKind({
  kind: "project",
  title: "Project",
  describe: (card) => `project ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderProject,
});

registerCardKind({
  kind: "sheet",
  title: "Sheet",
  describe: (card) => `sheet ${card.title !== "" && card.title !== undefined ? card.title : sheetSummary(card.doc)}`,
  create: () => ({ title: "", doc: emptySheet() }),
  render: renderSheet,
});

registerCardKind({
  kind: "frame",
  title: "Frame",
  describe: (card) => `frame ${card.title !== "" && card.title !== undefined ? card.title : "(unnamed)"}`,
  create: () => ({ title: "" }),
  render: renderFrame,
});
